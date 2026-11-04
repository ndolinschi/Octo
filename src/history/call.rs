use super::call_kind::CallKind;
use super::call_provider::CallProvider;
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
    pub status: u16,
    pub latency_ms: u64,
    pub request_bytes: usize,
    pub response_bytes: usize,
    pub input_tokens: Option<i64>,
    pub output_tokens: Option<i64>,
    pub cost: Option<f64>,
}
