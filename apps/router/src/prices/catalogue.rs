use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::history::ModelPrice;

/// One model's catalogue price, in USD per 1M tokens.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CatalogueEntry {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub canonical: Option<String>,
    pub input: f64,
    pub cache_read: f64,
    pub cache_write: f64,
    pub output: f64,
}

impl CatalogueEntry {
    pub fn price(&self, billed_as: Option<String>) -> ModelPrice {
        ModelPrice {
            input: self.input,
            cache_read: self.cache_read,
            cache_write: self.cache_write,
            output: self.output,
            billed_as,
            rates_complete: true,
        }
    }
}

/// The priced models of one catalogue response and when it was fetched.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CatalogueSnapshot {
    /// Unix seconds.
    pub fetched_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub etag: Option<String>,
    pub models: Vec<CatalogueEntry>,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum ParseError {
    #[error("catalogue response is not JSON: {0}")]
    Json(String),
    #[error("catalogue response has no data array")]
    NoData,
    #[error("catalogue response lists no priced model")]
    Empty,
}

/// What the parser skipped, for the refresh log.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ParseStats {
    pub listed: usize,
    pub dynamic: usize,
    pub malformed: usize,
}

/// Parses `GET /api/v1/models`: `{"data": [{"id", "canonical_slug", "pricing": {"prompt", "completion",
/// "input_cache_read", "input_cache_write", "overrides": [...]}}]}` with USD-per-token strings. Models with a missing,
/// unparsable or negative (`"-1"`, dynamic) prompt or completion price are skipped; a missing cache price is 0. Time-window
/// overrides (`utc_start`/`utc_end`) raise each rate to the highest window (a conservative estimate); token-count
/// overrides (`min_prompt_tokens`) are ignored, so the base rate applies.
pub fn parse_catalogue(body: &[u8]) -> Result<(Vec<CatalogueEntry>, ParseStats), ParseError> {
    let value: Value =
        serde_json::from_slice(body).map_err(|err| ParseError::Json(err.to_string()))?;
    let data = value
        .get("data")
        .and_then(Value::as_array)
        .ok_or(ParseError::NoData)?;
    let mut stats = ParseStats {
        listed: data.len(),
        ..ParseStats::default()
    };
    let mut models = Vec::with_capacity(data.len());
    for item in data {
        match parse_model(item) {
            Parsed::Entry(entry) => models.push(entry),
            Parsed::Dynamic => stats.dynamic += 1,
            Parsed::Malformed => stats.malformed += 1,
        }
    }
    if models.is_empty() {
        return Err(ParseError::Empty);
    }
    Ok((models, stats))
}

enum Parsed {
    Entry(CatalogueEntry),
    Dynamic,
    Malformed,
}

#[derive(Clone, Copy)]
struct Rates {
    input: f64,
    cache_read: f64,
    cache_write: f64,
    output: f64,
}

fn parse_model(item: &Value) -> Parsed {
    let Some(id) = item
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
    else {
        return Parsed::Malformed;
    };
    let Some(pricing) = item.get("pricing").filter(|p| p.is_object()) else {
        return Parsed::Malformed;
    };
    let mut rates = match rates(pricing) {
        Ok(rates) => rates,
        Err(skip) => return skip,
    };
    if let Some(overrides) = pricing.get("overrides").and_then(Value::as_array) {
        for window in overrides.iter().filter(|o| o.get("utc_start").is_some()) {
            if let Ok(peak) = rates_over(window, rates) {
                rates.input = rates.input.max(peak.input);
                rates.cache_read = rates.cache_read.max(peak.cache_read);
                rates.cache_write = rates.cache_write.max(peak.cache_write);
                rates.output = rates.output.max(peak.output);
            }
        }
    }
    let canonical = item
        .get("canonical_slug")
        .and_then(Value::as_str)
        .filter(|slug| !slug.is_empty() && *slug != id)
        .map(str::to_string);
    Parsed::Entry(CatalogueEntry {
        id: id.to_string(),
        canonical,
        input: rates.input,
        cache_read: rates.cache_read,
        cache_write: rates.cache_write,
        output: rates.output,
    })
}

fn rates(pricing: &Value) -> Result<Rates, Parsed> {
    let required = |key: &str| match per_million(pricing.get(key)) {
        Rate::Value(rate) => Ok(rate),
        Rate::Dynamic => Err(Parsed::Dynamic),
        Rate::Missing | Rate::Invalid => Err(Parsed::Malformed),
    };
    let optional = |key: &str| match per_million(pricing.get(key)) {
        Rate::Value(rate) => Ok(rate),
        Rate::Missing => Ok(0.0),
        Rate::Dynamic => Err(Parsed::Dynamic),
        Rate::Invalid => Err(Parsed::Malformed),
    };
    Ok(Rates {
        input: required("prompt")?,
        output: required("completion")?,
        cache_read: optional("input_cache_read")?,
        cache_write: optional("input_cache_write")?,
    })
}

fn rates_over(window: &Value, base: Rates) -> Result<Rates, ()> {
    let field = |key: &str, fallback: f64| match per_million(window.get(key)) {
        Rate::Value(rate) => Ok(rate),
        Rate::Missing => Ok(fallback),
        Rate::Dynamic | Rate::Invalid => Err(()),
    };
    Ok(Rates {
        input: field("prompt", base.input)?,
        cache_read: field("input_cache_read", base.cache_read)?,
        cache_write: field("input_cache_write", base.cache_write)?,
        output: field("completion", base.output)?,
    })
}

enum Rate {
    Value(f64),
    Missing,
    Dynamic,
    Invalid,
}

/// USD per token (string or number) to USD per 1M tokens, rounded to 1e-9 so `0.0000002028` reads `0.2028`.
fn per_million(value: Option<&Value>) -> Rate {
    let parsed = match value {
        None | Some(Value::Null) => return Rate::Missing,
        Some(Value::String(text)) => text.trim().parse::<f64>().ok(),
        Some(Value::Number(number)) => number.as_f64(),
        Some(_) => None,
    };
    match parsed {
        Some(rate) if !rate.is_finite() => Rate::Invalid,
        Some(rate) if rate < 0.0 => Rate::Dynamic,
        Some(rate) => Rate::Value((rate * 1e6 * 1e9).round() / 1e9),
        None => Rate::Invalid,
    }
}
