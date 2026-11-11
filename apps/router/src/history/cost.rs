use super::metrics::CostMicros;
use super::payload::ParsedUsage;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CostSource {
    Estimate,
    Upstream,
    OpenRouter,
    None,
}

impl CostSource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Estimate => "estimate",
            Self::Upstream => "upstream",
            Self::OpenRouter => "openrouter",
            Self::None => "none",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct ModelPrice {
    pub input: f64,
    pub cache_read: f64,
    pub cache_write: f64,
    pub output: f64,
    pub billed_as: Option<String>,
    pub rates_complete: bool,
}

impl ModelPrice {
    pub fn any_nonzero(&self) -> bool {
        self.input > 0.0 || self.cache_read > 0.0 || self.cache_write > 0.0 || self.output > 0.0
    }
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct PriceTable {
    rows: Vec<(String, ModelPrice)>,
}

impl PriceTable {
    pub fn new(rows: Vec<(String, ModelPrice)>) -> Self {
        Self { rows }
    }

    pub fn get(&self, model: &str) -> Option<&ModelPrice> {
        let needle = strip_price_model_id(model);
        self.rows
            .iter()
            .find(|(slug, _)| strip_price_model_id(slug) == needle)
            .map(|(_, price)| price)
    }
}

fn strip_price_model_id(model: &str) -> &str {
    let bare = model.trim_start_matches('~');
    match bare.rsplit_once('[') {
        Some((prefix, rest)) if rest.ends_with(']') && !prefix.is_empty() => prefix,
        _ => bare,
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct ResolvedCost {
    pub cost: Option<CostMicros>,
    pub or_cost: Option<CostMicros>,
    pub upstream_cost: Option<CostMicros>,
    pub estimated_cost: Option<CostMicros>,
    pub source: CostSource,
    pub is_byok: Option<bool>,
    pub upstream_provider: Option<String>,
}

pub fn resolve_cost(usage: &ParsedUsage, model: Option<&str>, prices: &PriceTable) -> ResolvedCost {
    let or_cost = usage.or_cost.or(usage.cost);
    let upstream_cost = usage.upstream_cost;
    let estimated_cost = model
        .and_then(|slug| prices.get(slug))
        .and_then(|price| estimate_cost(usage, price));

    let (cost, source) = if let Some(up) = upstream_cost.filter(|c| c.0 > 0) {
        (Some(up), CostSource::Upstream)
    } else if let Some(or) = or_cost.filter(|c| c.0 > 0) {
        (Some(or), CostSource::OpenRouter)
    } else if let Some(est) = estimated_cost.filter(|c| c.0 > 0) {
        (Some(est), CostSource::Estimate)
    } else {
        (None, CostSource::None)
    };

    ResolvedCost {
        cost,
        or_cost,
        upstream_cost,
        estimated_cost,
        source,
        is_byok: usage.is_byok,
        upstream_provider: usage.upstream_provider.clone(),
    }
}

/// Reported cost over table estimate beyond this relative gap is flagged (`estimate_ratio`, one WARN per model).
const ESTIMATE_RATIO_TOLERANCE: f64 = 0.25;

/// `reported / estimated` (2 decimals) when an upstream-reported cost (`upstream` or `openrouter` source) differs from
/// the price-table estimate for the same call by more than 25%. `None` when there is no estimate or no reported cost.
pub fn estimate_ratio(resolved: &ResolvedCost) -> Option<f64> {
    if !matches!(
        resolved.source,
        CostSource::Upstream | CostSource::OpenRouter
    ) {
        return None;
    }
    let reported = resolved.cost?.0 as f64;
    let estimated = resolved.estimated_cost.filter(|c| c.0 > 0)?.0 as f64;
    let ratio = reported / estimated;
    ((ratio - 1.0).abs() > ESTIMATE_RATIO_TOLERANCE).then(|| (ratio * 100.0).round() / 100.0)
}

/// Logs one WARN per model per process when [`estimate_ratio`] fires.
pub fn warn_estimate_ratio_once(model: &str, ratio: f64) {
    static SEEN: std::sync::Mutex<Vec<String>> = std::sync::Mutex::new(Vec::new());
    let Ok(mut seen) = SEEN.lock() else {
        return;
    };
    if seen.iter().any(|m| m == model) {
        return;
    }
    seen.push(model.to_string());
    tracing::warn!(
        model,
        ratio,
        "reported cost is {ratio:.2}x the price table for {model}; the table or provider routing is off"
    );
}

pub fn blended_cost_micros(price: &ModelPrice, input_tokens: u64, output_tokens: u64) -> u128 {
    token_micros(input_tokens, price.input) + token_micros(output_tokens, price.output)
}

fn token_micros(tokens: u64, rate_usd_per_mtok: f64) -> u128 {
    if !rate_usd_per_mtok.is_finite() || tokens == 0 {
        return 0;
    }
    let per_mtok_micros = (rate_usd_per_mtok * 1_000_000.0).round() as i128;
    if per_mtok_micros <= 0 {
        return 0;
    }
    (tokens as i128 * per_mtok_micros / 1_000_000) as u128
}

fn estimate_cost(usage: &ParsedUsage, price: &ModelPrice) -> Option<CostMicros> {
    if !price.rates_complete || !price.any_nonzero() {
        return None;
    }
    let input = usage.input_tokens.map(|t| t.0).unwrap_or(0);
    let cache_read = usage.cache_read_tokens.map(|t| t.0).unwrap_or(0);
    let cache_write = usage.cache_write_tokens.map(|t| t.0).unwrap_or(0);
    let output = usage.output_tokens.map(|t| t.0).unwrap_or(0);
    let uncached = if usage.input_includes_cache {
        input.saturating_sub(cache_read)
    } else {
        input
    };
    let micros = token_micros(uncached, price.input)
        + token_micros(cache_read, price.cache_read)
        + token_micros(cache_write, price.cache_write)
        + token_micros(output, price.output);
    if micros > u64::MAX as u128 {
        return None;
    }
    Some(CostMicros(micros as u64))
}
