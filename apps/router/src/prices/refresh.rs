use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use super::catalogue::{parse_catalogue, CatalogueSnapshot};
use super::source::{CatalogueSource, Fetched};
use super::{merge, now_unix, PriceBook};
use crate::auto::{RequestShape, Tiers};
use crate::history::{PriceSource, PriceTable};

const FIRST_RETRY: Duration = Duration::from_secs(60);
const MAX_RETRY: Duration = Duration::from_secs(3600);

#[derive(Debug, thiserror::Error)]
pub enum RefreshError {
    #[error(transparent)]
    Fetch(#[from] super::source::FetchError),
    #[error(transparent)]
    Parse(#[from] super::catalogue::ParseError),
    #[error("catalogue answered 304 Not Modified but no catalogue is loaded")]
    NotModifiedWithoutSnapshot,
}

/// What one applied catalogue changed.
#[derive(Debug, Clone, PartialEq)]
pub struct RefreshReport {
    pub models: usize,
    /// Models whose effective price changed.
    pub updated: usize,
    /// Models that had no price before.
    pub added: usize,
    /// The largest relative change, e.g. `deepseek/deepseek-v4.1-flash output 0.567 -> 0.2028`.
    pub biggest: Option<String>,
    /// Set when the price rule now serves a decided tier by another tier (`before` / `after` mapping).
    pub rule_changed: Option<(String, String)>,
    pub not_modified: bool,
}

/// Keeps a [`PriceBook`] in step with the catalogue: [`Refresher::load_cache`] at start, then [`Refresher::spawn`]
/// for the fetch loop (first fetch at once, then every `interval` with ±10% jitter; failures retry after 1, 2, 4, ...
/// minutes, at most an hour and at most the interval).
pub struct Refresher {
    book: PriceBook,
    base: PriceTable,
    source: Arc<dyn CatalogueSource>,
    cache_path: Option<PathBuf>,
    interval: Duration,
    ladder: Option<Tiers>,
    current: Mutex<Option<CatalogueSnapshot>>,
}

impl Refresher {
    /// `base` is the `prices.toml` table (manual and fallback rows).
    pub fn new(
        book: PriceBook,
        base: PriceTable,
        source: Arc<dyn CatalogueSource>,
        cache_path: Option<PathBuf>,
        interval: Duration,
    ) -> Self {
        book.update(|status| {
            status.cache_file = cache_path.as_ref().map(|path| path.display().to_string());
            status.interval_secs = interval.as_secs();
        });
        Self {
            book,
            base,
            source,
            cache_path,
            interval: interval.max(Duration::from_secs(60)),
            ladder: None,
            current: Mutex::new(None),
        }
    }

    /// The ladder whose price rule is compared before and after each refresh (it must share the book's live table).
    pub fn with_ladder(mut self, tiers: Tiers) -> Self {
        self.ladder = Some(tiers);
        self
    }

    /// Applies the disk cache, if there is one. Logs a warning when it is stale.
    pub fn load_cache(&self) -> Option<RefreshReport> {
        let path = self.cache_path.as_ref()?;
        let snapshot = super::cache::load(path)?;
        let report = self.apply(snapshot, true);
        if self.book.stale(now_unix()) {
            tracing::warn!(
                path = %path.display(),
                fetched_at = %crate::history::utc_timestamp(self.book.status().fetched_at.unwrap_or(0)),
                "cached catalogue prices are stale; using them until a fetch succeeds"
            );
        }
        Some(report)
    }

    /// One fetch: parse, apply, save the cache. A failure leaves the prices in use as they are.
    pub async fn refresh_once(&self) -> Result<RefreshReport, RefreshError> {
        let now = now_unix();
        self.book
            .update(|status| status.last_attempt_at = Some(now));
        let etag = self
            .lock()
            .as_ref()
            .and_then(|current| current.etag.clone());
        let result = self.fetch_snapshot(etag.as_deref(), now).await;
        match result {
            Ok((snapshot, not_modified)) => {
                if let Some(path) = &self.cache_path {
                    if let Err(err) = super::cache::save(path, &snapshot) {
                        tracing::warn!(path = %path.display(), %err, "could not save the price cache");
                    }
                }
                let mut report = self.apply(snapshot, false);
                report.not_modified = not_modified;
                self.book.update(|status| status.last_error = None);
                Ok(report)
            }
            Err(err) => {
                let message = err.to_string();
                self.book
                    .update(|status| status.last_error = Some(message.clone()));
                Err(err)
            }
        }
    }

    async fn fetch_snapshot(
        &self,
        etag: Option<&str>,
        now: u64,
    ) -> Result<(CatalogueSnapshot, bool), RefreshError> {
        match self.source.fetch(etag).await? {
            Fetched::NotModified => {
                let mut snapshot = self
                    .lock()
                    .clone()
                    .ok_or(RefreshError::NotModifiedWithoutSnapshot)?;
                snapshot.fetched_at = now;
                Ok((snapshot, true))
            }
            Fetched::Body { bytes, etag } => {
                let (models, stats) = parse_catalogue(&bytes)?;
                tracing::debug!(?stats, "price catalogue parsed");
                Ok((
                    CatalogueSnapshot {
                        fetched_at: now,
                        etag,
                        models,
                    },
                    false,
                ))
            }
        }
    }

    /// Installs `snapshot` merged with `prices.toml`, logs what changed and updates the status.
    pub fn apply(&self, snapshot: CatalogueSnapshot, from_cache: bool) -> RefreshReport {
        let merged = merge(&self.base, Some(&snapshot));
        let rule_before = self.ladder.as_ref().map(rule_map);
        let old = self.book.live().replace(merged);
        let new = self.book.live().snapshot();
        let rule_after = self.ladder.as_ref().map(rule_map);
        let mut report = diff(&old, &new, &snapshot);
        if let (Some(before), Some(after)) = (rule_before, rule_after) {
            if before != after {
                report.rule_changed = Some((before, after));
            }
        }
        self.book.update(|status| {
            status.fetched_at = Some(snapshot.fetched_at);
            status.from_cache = from_cache;
            status.models = snapshot.models.len();
        });
        let ladder = self.ladder.as_ref().map(ladder_costs).unwrap_or_default();
        tracing::info!(
            source = if from_cache { "cache" } else { "catalogue" },
            ladder = %ladder,
            fetched_at = %crate::history::utc_timestamp(snapshot.fetched_at),
            models = report.models,
            updated = report.updated,
            added = report.added,
            biggest = report.biggest.as_deref().unwrap_or("none"),
            "catalogue prices applied"
        );
        if let Some((before, after)) = &report.rule_changed {
            tracing::warn!(
                before = %before,
                after = %after,
                "price refresh changed which tier the price rule serves; sessions keep their decided tier, their next request is served by the new mapping"
            );
            if let Some(ladder) = &self.ladder {
                for warning in crate::auto::ladder_warnings(ladder) {
                    tracing::warn!("{warning}");
                }
            }
        }
        *self.lock() = Some(snapshot);
        report
    }

    /// Runs the fetch loop in the background.
    pub fn spawn(self) -> tokio::task::JoinHandle<()> {
        tokio::spawn(async move {
            let mut failures = 0u32;
            loop {
                let wait = match self.refresh_once().await {
                    Ok(_) => {
                        failures = 0;
                        jittered(self.interval, now_nanos())
                    }
                    Err(err) => {
                        failures = failures.saturating_add(1);
                        let wait = retry_delay(failures, self.interval);
                        tracing::warn!(%err, retry_in_secs = wait.as_secs(), "price catalogue refresh failed; keeping the prices in use");
                        wait
                    }
                };
                tokio::time::sleep(wait).await;
            }
        })
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Option<CatalogueSnapshot>> {
        self.current
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

/// `interval` moved by up to ±10%, picked from `seed`.
pub fn jittered(interval: Duration, seed: u64) -> Duration {
    let spread = interval.as_millis() as u64 / 10;
    if spread == 0 {
        return interval;
    }
    let mixed = seed.wrapping_mul(0x9E37_79B9_7F4A_7C15).rotate_left(17);
    let offset = mixed % (2 * spread + 1);
    Duration::from_millis(interval.as_millis() as u64 - spread + offset)
}

/// Delay before retry number `failures` (1-based): 1, 2, 4, ... minutes, capped at an hour and at `interval`.
pub fn retry_delay(failures: u32, interval: Duration) -> Duration {
    let doubled = FIRST_RETRY.saturating_mul(1u32 << failures.saturating_sub(1).min(16));
    doubled.min(MAX_RETRY).min(interval.max(FIRST_RETRY))
}

fn now_nanos() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0)
}

fn rule_map(tiers: &Tiers) -> String {
    let shape = RequestShape::default();
    ["low", "mid", "high"]
        .iter()
        .map(|band| format!("{band}->{}", tiers.served_band(band, None, shape)))
        .collect::<Vec<_>>()
        .join(", ")
}

/// `low 1622, mid 4800, high 1390 micro-USD per 30000 in / 500 out`.
fn ladder_costs(tiers: &Tiers) -> String {
    let shape = RequestShape::default();
    let costs: Vec<String> = ["low", "mid", "high"]
        .iter()
        .map(|band| match tiers.blended_cost_micros(band, shape) {
            Some(cost) => format!("{band} {cost}"),
            None => format!("{band} unpriced"),
        })
        .collect();
    format!(
        "{} micro-USD per {} in / {} out",
        costs.join(", "),
        shape.input_tokens,
        shape.output_tokens
    )
}

fn diff(old: &PriceTable, new: &PriceTable, snapshot: &CatalogueSnapshot) -> RefreshReport {
    let mut report = RefreshReport {
        models: snapshot.models.len(),
        updated: 0,
        added: 0,
        biggest: None,
        rule_changed: None,
        not_modified: false,
    };
    let mut biggest = -1.0f64;
    for entry in &snapshot.models {
        let Some((price, PriceSource::Catalogue { .. })) = new.get_with_source(&entry.id) else {
            continue;
        };
        let Some(before) = old.get(&entry.id) else {
            report.added += 1;
            continue;
        };
        let fields = [
            ("input", before.input, price.input),
            ("cache_read", before.cache_read, price.cache_read),
            ("cache_write", before.cache_write, price.cache_write),
            ("output", before.output, price.output),
        ];
        let mut changed = false;
        for (name, from, to) in fields {
            if (from - to).abs() <= 1e-12 {
                continue;
            }
            changed = true;
            // Factor of change (|ln(to/from)|); a change from or to zero ranks below every other change.
            let relative = if from > 0.0 && to > 0.0 {
                (to / from).ln().abs()
            } else {
                0.0
            };
            if relative > biggest {
                biggest = relative;
                report.biggest = Some(format!("{} {name} {from} -> {to}", entry.id));
            }
        }
        report.updated += usize::from(changed);
    }
    report
}
