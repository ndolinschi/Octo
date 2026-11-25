pub const FILL_THRESHOLD: f64 = 0.75;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ContextEstimate {
    pub input_tokens_est: u64,
    pub usable: u64,
    pub fill: f64,
}

pub fn estimate_tokens(bytes: usize) -> u64 {
    (bytes / 4) as u64
}

pub fn output_reserve(context_length: u64, max_tokens: u64) -> u64 {
    let requested = if max_tokens == 0 { 4096 } else { max_tokens };
    let cap = (context_length / 2).max(1);
    requested.min(cap)
}

pub fn usable_window(context_length: u64, max_tokens: u64) -> u64 {
    context_length.saturating_sub(output_reserve(context_length, max_tokens))
}

pub fn context_estimate(
    input_bytes: usize,
    context_length: u64,
    max_tokens: u64,
) -> ContextEstimate {
    let input_tokens_est = estimate_tokens(input_bytes);
    let usable = usable_window(context_length, max_tokens);
    let fill = if usable == 0 {
        1.0
    } else {
        input_tokens_est as f64 / usable as f64
    };
    ContextEstimate {
        input_tokens_est,
        usable,
        fill,
    }
}

pub fn dropped(previous: u64, current: u64) -> bool {
    previous > 0 && current * 2 < previous
}

pub fn needs_compact(estimate: ContextEstimate) -> bool {
    estimate.usable < 1024 || estimate.fill >= FILL_THRESHOLD
}
