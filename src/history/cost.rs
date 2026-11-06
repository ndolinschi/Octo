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
        let needle = model.trim_start_matches('~');
        self.rows
            .iter()
            .find(|(slug, _)| slug == needle || slug.trim_start_matches('~') == needle)
            .map(|(_, price)| price)
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

fn estimate_cost(usage: &ParsedUsage, price: &ModelPrice) -> Option<CostMicros> {
    if !price.any_nonzero() {
        return None;
    }
    let input = usage.input_tokens.map(|t| t.0).unwrap_or(0);
    let cache_read = usage.cache_read_tokens.map(|t| t.0).unwrap_or(0);
    let cache_write = usage.cache_write_tokens.map(|t| t.0).unwrap_or(0);
    let output = usage.output_tokens.map(|t| t.0).unwrap_or(0);
    let uncached = input.saturating_sub(cache_read);
    let usd = (uncached as f64) * price.input / 1_000_000.0
        + (cache_read as f64) * price.cache_read / 1_000_000.0
        + (cache_write as f64) * price.cache_write / 1_000_000.0
        + (output as f64) * price.output / 1_000_000.0;
    if !usd.is_finite() || usd <= 0.0 {
        return None;
    }
    let micros = (usd * 1_000_000.0).round();
    if micros > u64::MAX as f64 {
        return None;
    }
    Some(CostMicros(micros as u64))
}
