//! Catalogue prices: the router refreshes model prices from the public OpenRouter catalogue and merges them with
//! `prices.toml`. Precedence per model: a `source = "manual"` row > the catalogue > a plain (fallback) row > none.

mod cache;
mod catalogue;
mod refresh;
mod source;

use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

pub use cache::{default_cache_path, load as load_cache, save as save_cache, CACHE_FILE_NAME};
pub use catalogue::{parse_catalogue, CatalogueEntry, CatalogueSnapshot, ParseError, ParseStats};
pub use refresh::{jittered, retry_delay, RefreshError, RefreshReport, Refresher};
pub use source::{
    CatalogueSource, FetchError, Fetched, HttpCatalogue, CATALOGUE_URL, FETCH_TIMEOUT,
    MAX_CATALOGUE_BYTES, USER_AGENT,
};

use crate::history::{utc_timestamp, LivePrices, PriceSource, PriceTable};

/// Environment override for `[prices] refresh`: `off` or `catalogue`. Any other value counts as `off`.
pub const REFRESH_ENV: &str = "OCTO_PRICES_REFRESH";
pub const DEFAULT_REFRESH_INTERVAL_SECS: u64 = 6 * 3600;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RefreshMode {
    Catalogue,
    Off,
}

impl RefreshMode {
    pub fn parse(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "catalogue" | "catalog" => Some(Self::Catalogue),
            "off" => Some(Self::Off),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Catalogue => "catalogue",
            Self::Off => "off",
        }
    }
}

/// `[prices]` scalar keys in `prices.toml`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RefreshSettings {
    /// `None`: on when every OpenRouter upstream URL is on openrouter.ai, off otherwise (a mock or proxy upstream).
    pub refresh: Option<RefreshMode>,
    pub interval_secs: u64,
    /// Cache file; `None`: `prices-catalogue.json` beside the history database.
    pub cache_file: Option<String>,
}

impl Default for RefreshSettings {
    fn default() -> Self {
        Self {
            refresh: None,
            interval_secs: DEFAULT_REFRESH_INTERVAL_SECS,
            cache_file: None,
        }
    }
}

/// Whether to refresh and why: the env var wins, then `[prices] refresh`, then the upstream rule.
pub fn resolve_mode(
    setting: Option<RefreshMode>,
    env: Option<&str>,
    upstream_urls: &[&str],
) -> (RefreshMode, String) {
    if let Some(raw) = env.map(str::trim).filter(|raw| !raw.is_empty()) {
        let mode = RefreshMode::parse(raw).unwrap_or(RefreshMode::Off);
        return (mode, format!("{REFRESH_ENV}={raw}"));
    }
    if let Some(mode) = setting {
        return (mode, "prices.refresh".to_string());
    }
    match upstream_urls.iter().find(|url| !is_openrouter(url)) {
        None => (
            RefreshMode::Catalogue,
            "default: upstream is openrouter.ai".to_string(),
        ),
        Some(url) => (
            RefreshMode::Off,
            format!("default: upstream {url} is not openrouter.ai"),
        ),
    }
}

fn is_openrouter(url: &str) -> bool {
    reqwest::Url::parse(url)
        .ok()
        .and_then(|url| url.host_str().map(str::to_ascii_lowercase))
        .is_some_and(|host| host == "openrouter.ai" || host.ends_with(".openrouter.ai"))
}

/// The mode for a loaded config, reading [`REFRESH_ENV`].
pub fn mode_for(config: &crate::config::Config) -> (RefreshMode, String) {
    let env = std::env::var(REFRESH_ENV).ok();
    resolve_mode(
        config.price_refresh.refresh,
        env.as_deref(),
        &[
            config.openrouter_messages_url.as_str(),
            config.openrouter_chat_completions_url.as_str(),
            config.openrouter_decisions_url.as_str(),
        ],
    )
}

/// Merges `prices.toml` rows (`file`) with a catalogue snapshot: manual rows first, then catalogue rows (under the
/// model id and its canonical slug, skipped where a manual row names either), then fallback rows. The first row for a
/// slug wins, which gives manual > catalogue > fallback. A catalogue row keeps the file row's `billed_as`.
pub fn merge(file: &PriceTable, catalogue: Option<&CatalogueSnapshot>) -> PriceTable {
    let mut rows = Vec::new();
    for (slug, price, source) in file.rows() {
        if source == PriceSource::Manual {
            rows.push((slug.to_string(), price.clone(), source));
        }
    }
    if let Some(snapshot) = catalogue {
        let manual = |slug: &str| file.source(slug) == Some(PriceSource::Manual);
        let source = PriceSource::Catalogue {
            fetched_at: snapshot.fetched_at,
        };
        for entry in &snapshot.models {
            let canonical = entry.canonical.as_deref();
            if manual(&entry.id) || canonical.is_some_and(manual) {
                continue;
            }
            let billed_as = file
                .get(&entry.id)
                .or_else(|| canonical.and_then(|slug| file.get(slug)))
                .and_then(|row| row.billed_as.clone());
            let price = entry.price(billed_as);
            if let Some(alias) = canonical {
                rows.push((alias.to_string(), price.clone(), source));
            }
            rows.push((entry.id.clone(), price, source));
        }
    }
    for (slug, price, source) in file.rows() {
        if source == PriceSource::Fallback {
            rows.push((slug.to_string(), price.clone(), source));
        }
    }
    PriceTable::with_sources(rows)
}

pub fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Refresh state for `/health`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RefreshStatus {
    pub mode: RefreshMode,
    pub reason: String,
    pub interval_secs: u64,
    pub cache_file: Option<String>,
    /// When the catalogue prices in use were fetched (unix seconds); `None` until one is loaded.
    pub fetched_at: Option<u64>,
    /// The prices in use came from the disk cache, not from a fetch by this process.
    pub from_cache: bool,
    pub models: usize,
    pub last_attempt_at: Option<u64>,
    pub last_error: Option<String>,
}

/// The live price table and its refresh status, shared by the router state, the ladder and history.
#[derive(Clone)]
pub struct PriceBook {
    live: LivePrices,
    status: Arc<Mutex<RefreshStatus>>,
}

impl PriceBook {
    pub fn new(table: PriceTable, mode: RefreshMode, reason: String, interval_secs: u64) -> Self {
        Self {
            live: LivePrices::new(table),
            status: Arc::new(Mutex::new(RefreshStatus {
                mode,
                reason,
                interval_secs,
                cache_file: None,
                fetched_at: None,
                from_cache: false,
                models: 0,
                last_attempt_at: None,
                last_error: None,
            })),
        }
    }

    /// The book for a loaded config: `prices.toml` rows only, mode from [`mode_for`].
    pub fn from_config(config: &crate::config::Config) -> Self {
        let (mode, reason) = mode_for(config);
        Self::new(
            merge(&config.prices, None),
            mode,
            reason,
            config.price_refresh.interval_secs,
        )
    }

    pub fn live(&self) -> LivePrices {
        self.live.clone()
    }

    pub fn status(&self) -> RefreshStatus {
        self.lock().clone()
    }

    pub(crate) fn update(&self, change: impl FnOnce(&mut RefreshStatus)) {
        change(&mut self.lock());
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, RefreshStatus> {
        self.status
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Catalogue prices older than twice the refresh interval are stale.
    pub fn stale(&self, now: u64) -> bool {
        let status = self.status();
        status
            .fetched_at
            .is_some_and(|at| now.saturating_sub(at) > status.interval_secs.saturating_mul(2))
    }

    /// The `prices` object of `GET /health`.
    pub fn health_json(&self, now: u64) -> serde_json::Value {
        let status = self.status();
        let table = self.live.snapshot();
        let (mut manual, mut catalogue, mut fallback) = (0usize, 0usize, 0usize);
        for (_, _, source) in table.rows() {
            match source {
                PriceSource::Manual => manual += 1,
                PriceSource::Catalogue { .. } => catalogue += 1,
                PriceSource::Fallback => fallback += 1,
            }
        }
        let fetched = status.fetched_at.map(|at| {
            serde_json::json!({
                "fetched_at": utc_timestamp(at),
                "age_secs": now.saturating_sub(at),
                "stale": self.stale(now),
                "models": status.models,
                "from_cache": status.from_cache,
            })
        });
        serde_json::json!({
            "refresh": status.mode.as_str(),
            "reason": status.reason,
            "interval_secs": status.interval_secs,
            "rows": {"manual": manual, "catalogue": catalogue, "fallback": fallback},
            "catalogue": fetched,
            "last_attempt_at": status.last_attempt_at.map(utc_timestamp),
            "last_error": status.last_error,
        })
    }
}

/// Starts the catalogue refresh for a running router when the mode is `catalogue`: loads the disk cache at once, then
/// fetches in the background (the router serves with the table it has until the fetch returns).
pub fn start(
    config: &crate::config::Config,
    book: &PriceBook,
    ladder: &crate::auto::Tiers,
) -> Option<tokio::task::JoinHandle<()>> {
    let status = book.status();
    if status.mode == RefreshMode::Off {
        tracing::info!(reason = %status.reason, "price catalogue refresh is off; prices.toml only");
        return None;
    }
    let source = match HttpCatalogue::new(CATALOGUE_URL) {
        Ok(source) => source,
        Err(err) => {
            tracing::warn!(%err, "price catalogue refresh disabled: no HTTP client");
            return None;
        }
    };
    let cache = config
        .price_refresh
        .cache_file
        .as_ref()
        .map(std::path::PathBuf::from)
        .or_else(|| default_cache_path(&config.history_database_path));
    let refresher = Refresher::new(
        book.clone(),
        config.prices.clone(),
        Arc::new(source),
        cache,
        std::time::Duration::from_secs(config.price_refresh.interval_secs),
    )
    .with_ladder(ladder.clone());
    refresher.load_cache();
    tracing::info!(
        reason = %status.reason,
        interval_secs = config.price_refresh.interval_secs,
        "price catalogue refresh is on"
    );
    Some(refresher.spawn())
}
