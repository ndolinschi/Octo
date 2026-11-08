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

    // first non-zero: estimate → upstream → openrouter; zero estimate still recorded in estimated_cost
    let (cost, source) = if let Some(est) = estimated_cost.filter(|c| c.0 > 0) {
        (Some(est), CostSource::Estimate)
    } else if let Some(up) = upstream_cost.filter(|c| c.0 > 0) {
        (Some(up), CostSource::Upstream)
    } else if let Some(or) = or_cost.filter(|c| c.0 > 0) {
        (Some(or), CostSource::OpenRouter)
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
    let uncached = input.saturating_sub(cache_read);
    let micros = token_micros(uncached, price.input)
        + token_micros(cache_read, price.cache_read)
        + token_micros(cache_write, price.cache_write)
        + token_micros(output, price.output);
    if micros > u64::MAX as u128 {
        return None;
    }
    Some(CostMicros(micros as u64))
}
