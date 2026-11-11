use serde_json::Value;

use super::super::metrics::{CostMicros, TokenCount};
use super::{DroppedStream, ParsedUsage};

pub fn parse_json_body(body: &str) -> Value {
    serde_json::from_str(body).unwrap_or_else(|_| {
        serde_json::json!({
            "raw": body,
        })
    })
}

pub fn describe_input(body: &str) -> (Option<String>, Option<String>) {
    let Ok(value) = serde_json::from_str::<Value>(body) else {
        return (None, None);
    };
    let model = value
        .get("model")
        .and_then(Value::as_str)
        .map(str::to_string);
    let message = message_from_value(&value);
    (model, message)
}

fn message_from_value(value: &Value) -> Option<String> {
    if let Some(messages) = value.get("messages").and_then(Value::as_array) {
        for message in messages.iter().rev() {
            if message.get("role").and_then(Value::as_str) == Some("user") {
                if let Some(text) = content_text(message.get("content")) {
                    return Some(text);
                }
            }
        }
    }
    content_text(value.get("input")).or_else(|| content_text(value.get("prompt")))
}

fn content_text(content: Option<&Value>) -> Option<String> {
    let content = content?;
    if let Some(text) = content.as_str() {
        return Some(text.to_string());
    }
    if let Some(parts) = content.as_array() {
        let mut text = String::new();
        for part in parts {
            if let Some(piece) = part.get("text").and_then(Value::as_str) {
                text.push_str(piece);
            } else if let Some(piece) = part.as_str() {
                text.push_str(piece);
            }
        }
        if !text.is_empty() {
            return Some(text);
        }
    }
    None
}

pub fn tail_suffix_bytes(tail: &[u8], response_bytes: usize, prefix_len: usize) -> &[u8] {
    let tail_len = tail.len();
    if tail_len == 0 {
        return &[];
    }
    let tail_start = response_bytes.saturating_sub(tail_len);
    if tail_start >= prefix_len {
        return tail;
    }
    let skip = prefix_len - tail_start;
    tail.get(skip..).unwrap_or(&[])
}

pub fn streaming_events(prefix: &str, tail: &str, response_bytes: usize) -> Vec<Value> {
    let suffix = tail_suffix_bytes(tail.as_bytes(), response_bytes, prefix.len());
    let mut events = sse_events(prefix);
    if suffix.is_empty() {
        return events;
    }
    for event in sse_events(&String::from_utf8_lossy(suffix)) {
        events.push(event);
    }
    events
}

pub fn streaming_response(format: &str, prefix: &str, tail: &str, response_bytes: usize) -> Value {
    serde_json::json!({
        "format": format,
        "events": streaming_events(prefix, tail, response_bytes),
    })
}

pub fn sse_events(captured: &str) -> Vec<Value> {
    let mut events = Vec::new();
    for line in captured.lines() {
        let line = line.trim();
        let payload = line.strip_prefix("data:").map(str::trim).unwrap_or(line);
        if payload.is_empty() || payload == "[DONE]" {
            continue;
        }
        if let Ok(value) = serde_json::from_str::<Value>(payload) {
            events.push(value);
        }
    }
    events
}

pub fn usage_from_output(output: &str) -> ParsedUsage {
    let mut found = ParsedUsage::EMPTY;
    found = fold_usage(found, output);
    for line in output.lines() {
        let line = line.trim();
        let payload = line.strip_prefix("data:").map(str::trim).unwrap_or(line);
        if payload.is_empty() || payload == "[DONE]" {
            continue;
        }
        found = fold_usage(found, payload);
    }
    found
}

pub fn complete_dropped_usage(mut usage: ParsedUsage, stream: DroppedStream<'_>) -> ParsedUsage {
    let seen_bytes = streamed_text_bytes(&stream);
    let seen_tokens = (seen_bytes / 4) as u64;
    let reported = usage.output_tokens.map(|count| count.0);
    if seen_tokens > 0 && reported.is_none_or(|count| count < seen_tokens) {
        usage.output_tokens = Some(TokenCount(seen_tokens));
    }
    if usage.input_tokens.is_none() && stream.request_bytes > 0 {
        usage.input_tokens = Some(TokenCount((stream.request_bytes / 4) as u64));
        usage.input_includes_cache = false;
    }
    usage
}

fn streamed_text_bytes(stream: &DroppedStream<'_>) -> usize {
    let suffix = tail_suffix_bytes(
        stream.tail.as_bytes(),
        stream.response_bytes,
        stream.prefix.len(),
    );
    let captured = stream.prefix.len() + suffix.len();
    if captured == 0 {
        return 0;
    }
    let text: usize = streaming_events(stream.prefix, stream.tail, stream.response_bytes)
        .iter()
        .map(event_text_bytes)
        .sum();
    let scaled = (text as u128).saturating_mul(stream.response_bytes.max(captured) as u128)
        / captured as u128;
    usize::try_from(scaled).unwrap_or(usize::MAX)
}

fn event_text_bytes(event: &Value) -> usize {
    let mut total = 0;
    if let Some(delta) = event.get("delta") {
        for key in ["text", "partial_json", "thinking"] {
            total += delta.get(key).and_then(Value::as_str).map_or(0, str::len);
        }
    }
    if let Some(choices) = event.get("choices").and_then(Value::as_array) {
        for choice in choices {
            if let Some(delta) = choice.get("delta") {
                for key in ["content", "reasoning"] {
                    total += delta.get(key).and_then(Value::as_str).map_or(0, str::len);
                }
            }
        }
    }
    total
}

pub fn usage_from_parts(prefix: &str, tail: &str, response_bytes: usize) -> ParsedUsage {
    let suffix = tail_suffix_bytes(tail.as_bytes(), response_bytes, prefix.len());
    let head = usage_from_output(prefix);
    let end = if suffix.is_empty() {
        ParsedUsage::EMPTY
    } else {
        usage_from_output(&String::from_utf8_lossy(suffix))
    };
    let input_includes_cache = if head.input_tokens.is_some() {
        head.input_includes_cache
    } else {
        end.input_includes_cache
    };
    ParsedUsage {
        input_includes_cache,
        input_tokens: head.input_tokens.or(end.input_tokens),
        output_tokens: end.output_tokens.or(head.output_tokens),
        cost: end.cost.or(head.cost),
        or_cost: end.or_cost.or(head.or_cost),
        upstream_cost: end.upstream_cost.or(head.upstream_cost),
        is_byok: end.is_byok.or(head.is_byok),
        upstream_provider: end.upstream_provider.or(head.upstream_provider),
        cache_read_tokens: end.cache_read_tokens.or(head.cache_read_tokens),
        cache_write_tokens: end.cache_write_tokens.or(head.cache_write_tokens),
        generation_id: head.generation_id.or(end.generation_id),
    }
}

fn fold_usage(found: ParsedUsage, raw: &str) -> ParsedUsage {
    let Ok(value) = serde_json::from_str::<Value>(raw) else {
        return found;
    };
    let found = apply_generation_id(found, &value);
    let found = apply_provider(found, &value);
    let found = apply_usage(found, value.get("usage"));
    apply_usage(
        found,
        value
            .get("message")
            .and_then(|message| message.get("usage")),
    )
}

fn apply_provider(found: ParsedUsage, value: &Value) -> ParsedUsage {
    if found.upstream_provider.is_some() {
        return found;
    }
    let provider = value
        .get("provider")
        .and_then(Value::as_str)
        .or_else(|| {
            value
                .get("message")
                .and_then(|message| message.get("provider"))
                .and_then(Value::as_str)
        })
        .map(str::to_string);
    ParsedUsage {
        upstream_provider: provider,
        ..found
    }
}

fn apply_generation_id(found: ParsedUsage, value: &Value) -> ParsedUsage {
    if found.generation_id.is_some() {
        return found;
    }
    let id = value
        .get("id")
        .and_then(Value::as_str)
        .or_else(|| {
            value
                .get("message")
                .and_then(|message| message.get("id"))
                .and_then(Value::as_str)
        })
        .map(str::to_string);
    ParsedUsage {
        generation_id: id,
        ..found
    }
}

fn apply_usage(found: ParsedUsage, usage: Option<&Value>) -> ParsedUsage {
    let Some(usage) = usage else {
        return found;
    };
    let (input_tokens, input_includes_cache) =
        if let Some(count) = json_token_count(usage.get("prompt_tokens")) {
            (Some(count), true)
        } else if let Some(count) = json_token_count(usage.get("input_tokens")) {
            (Some(count), false)
        } else {
            (found.input_tokens, found.input_includes_cache)
        };
    let output_tokens = json_token_count(usage.get("completion_tokens"))
        .or_else(|| json_token_count(usage.get("output_tokens")))
        .or(found.output_tokens);
    let or_cost = json_cost_micros(usage.get("cost")).or(found.or_cost);
    let upstream_cost = usage
        .get("cost_details")
        .and_then(|details| json_cost_micros(details.get("upstream_inference_cost")))
        .or(found.upstream_cost);
    let is_byok = usage
        .get("is_byok")
        .and_then(Value::as_bool)
        .or(found.is_byok);
    let cost = or_cost.or(found.cost);
    let cache_read_tokens = json_token_count(usage.get("cache_read_input_tokens"))
        .or_else(|| {
            usage
                .get("prompt_tokens_details")
                .and_then(|details| json_token_count(details.get("cached_tokens")))
        })
        .or(found.cache_read_tokens);
    let cache_write_tokens =
        json_token_count(usage.get("cache_creation_input_tokens")).or(found.cache_write_tokens);
    ParsedUsage {
        input_includes_cache,
        input_tokens,
        output_tokens,
        cost,
        or_cost,
        upstream_cost,
        is_byok,
        upstream_provider: found.upstream_provider,
        cache_read_tokens,
        cache_write_tokens,
        generation_id: found.generation_id,
    }
}

fn json_token_count(value: Option<&Value>) -> Option<TokenCount> {
    value.and_then(|v| {
        if let Some(n) = v.as_u64() {
            return Some(TokenCount(n));
        }
        if let Some(n) = v.as_i64() {
            return u64::try_from(n).ok().map(TokenCount);
        }
        v.as_f64().and_then(|n| {
            if n.is_finite() && n >= 0.0 {
                Some(TokenCount(n as u64))
            } else {
                None
            }
        })
    })
}

fn json_cost_micros(value: Option<&Value>) -> Option<CostMicros> {
    let v = value?;
    let n = v.as_f64()?;
    if !n.is_finite() || n < 0.0 {
        return None;
    }
    let micros = (n * 1_000_000.0).round();
    if micros > u64::MAX as f64 {
        return None;
    }
    Some(CostMicros(micros as u64))
}

pub fn cost_micros_from_json(value: &Value) -> Option<CostMicros> {
    json_cost_micros(value.get("cost")).or_else(|| {
        value
            .get("usage")
            .and_then(|usage| json_cost_micros(usage.get("cost")))
    })
}
