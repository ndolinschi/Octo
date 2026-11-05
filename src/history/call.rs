use std::sync::Arc;

use super::call_kind::CallKind;
use super::call_provider::CallProvider;
use super::metrics::{CostMicros, Millis, TokenCount};
use super::History;

pub type ResponseHook = Arc<dyn Fn(&str) + Send + Sync>;

pub struct CallObserve {
    pub history: History,
    pub kind: CallKind,
    pub provider: CallProvider,
    pub rerouting: i64,
    pub rerouting_reason: Option<String>,
    pub session_id: Option<String>,
    pub tier_before: Option<String>,
    pub tier_after: Option<String>,
    pub trigger: String,
    pub auto: Option<crate::auto::Auto>,
    pub on_response: Option<ResponseHook>,
}

pub struct DecisionRow {
    pub session_id: Option<String>,
    pub purpose: String,
    pub model: String,
    pub status: u16,
    pub latency_ms: u128,
    pub user_text: String,
    pub is_hard: Option<bool>,
    pub is_easy: Option<bool>,
    pub is_hard_score: Option<f64>,
    pub is_easy_score: Option<f64>,
    pub tools_enough: Option<String>,
    pub complexity: Option<&'static str>,
    pub choice_rule: String,
    pub missing_tools: Option<String>,
    pub request_payload: String,
    pub response_payload: String,
    pub cost: Option<CostMicros>,
}

pub struct FinishedCall {
    pub kind: CallKind,
    pub provider: CallProvider,
    pub model: Option<String>,
    pub token_hash: Option<String>,
    pub message: Option<String>,
    pub input: String,
    pub output: String,
    pub request_payload: String,
    pub response_payload: String,
    pub status: u16,
    pub latency_ms: Millis,
    pub request_bytes: usize,
    pub response_bytes: usize,
    pub input_tokens: Option<TokenCount>,
    pub output_tokens: Option<TokenCount>,
    pub cost: Option<CostMicros>,
    pub rerouting: i64,
    pub rerouting_reason: Option<String>,
    pub session_id: Option<String>,
    pub tier_before: Option<String>,
    pub tier_after: Option<String>,
    pub trigger: String,
}
