use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;

const CALL_STORE_CAP: usize = 4096;

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CallRow {
    pub model: String,
    pub tier: String,
    pub trigger: String,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_write_tokens: u64,
    pub cost_usd: f64,
    pub cost_source: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub route: Option<RouteRecord>,
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
