use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;

const CALL_STORE_CAP: usize = 4096;

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CallRow {
    pub model: String,
    pub tier: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub decided_tier: Option<String>,
    pub trigger: String,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_write_tokens: u64,
    pub cost_usd: f64,
    pub cost_source: &'static str,
    /// Reported cost / price-table estimate (2 decimals), set only when they differ by more than 25%.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub estimate_ratio: Option<f64>,
    /// Where the price row behind the estimate came from: `manual`, `catalogue@YYYY-MM-DD` or `fallback`. Set when the
    /// call had a table estimate (whether or not the estimate was the charged cost).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub price_source: Option<String>,
    /// The upstream's id for the call: the OpenRouter generation id (`gen-…`, usable with its generation lookup) when
    /// it returned one, else whatever `id` the response carried (Anthropic-style `msg_…` on the messages path).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub upstream_id: Option<String>,
    /// The budget key's spend (USD, micro-USD precision) once this call was charged, classifier cost included.
    /// Set for every call charged to a budget key.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub spent_after_usd: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub route: Option<RouteRecord>,
}

pub fn micros_usd(micros: u64) -> f64 {
    micros as f64 / 1_000_000.0
}

#[derive(Debug, Clone, PartialEq)]
pub struct PersistedCall {
    pub request_id: String,
    pub session_id: Option<String>,
    pub budget_key: Option<String>,
    pub row: CallRow,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct RouteRecord {
    pub choice: String,
    pub band: &'static str,
    pub reason: String,
    pub classifier: &'static str,
    pub depth: u32,
    pub budget_key: String,
}

#[derive(Debug, Default)]
pub struct CallStore {
    rows: HashMap<String, CallRow>,
    order: VecDeque<String>,
}

impl CallStore {
    pub fn insert(&mut self, id: String, row: CallRow) {
        if self.rows.insert(id.clone(), row).is_none() {
            self.order.push_back(id);
        }
        while self.order.len() > CALL_STORE_CAP {
            if let Some(oldest) = self.order.pop_front() {
                self.rows.remove(&oldest);
            }
        }
    }

    pub fn get(&self, id: &str) -> Option<CallRow> {
        self.rows.get(id).cloned()
    }
}

pub fn new_request_id() -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let seq = COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("octo_{nanos:x}{seq:04x}")
}
