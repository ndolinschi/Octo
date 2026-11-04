use super::call_kind::CallKind;
use super::call_provider::CallProvider;
use super::metrics::{CostMicros, Millis, TokenCount};
use super::History;

pub struct CallObserve {
    pub history: History,
    pub kind: CallKind,
    pub provider: CallProvider,
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
}
