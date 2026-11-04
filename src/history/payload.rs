use serde_json::Value;

use super::metrics::{CostMicros, TokenCount};

#[derive(Clone, Copy)]
pub struct ParsedUsage {
    pub input_tokens: Option<TokenCount>,
    pub output_tokens: Option<TokenCount>,
    pub cost: Option<CostMicros>,
}

impl ParsedUsage {
    const EMPTY: Self = Self {
        input_tokens: None,
        output_tokens: None,
        cost: None,
    };
}

pub fn token_from_headers(headers: &axum::http::HeaderMap) -> String {
    if let Some(value) = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
    {
        let secret = value
            .strip_prefix("Bearer ")
            .or_else(|| value.strip_prefix("bearer "))
            .unwrap_or(value);
        if !secret.is_empty() {
            return secret.to_string();
        }
    }
    if let Some(value) = headers.get("x-api-key").and_then(|v| v.to_str().ok()) {
        if !value.is_empty() {
            return value.to_string();
        }
    }
    String::new()
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

fn fold_usage(found: ParsedUsage, raw: &str) -> ParsedUsage {
    let Ok(value) = serde_json::from_str::<Value>(raw) else {
        return found;
    };
    let found = apply_usage(found, value.get("usage"));
    apply_usage(
        found,
        value
            .get("message")
            .and_then(|message| message.get("usage")),
    )
}

fn apply_usage(found: ParsedUsage, usage: Option<&Value>) -> ParsedUsage {
    let Some(usage) = usage else {
        return found;
    };
    let input_tokens = json_token_count(usage.get("prompt_tokens"))
        .or_else(|| json_token_count(usage.get("input_tokens")))
        .or(found.input_tokens);
    let output_tokens = json_token_count(usage.get("completion_tokens"))
        .or_else(|| json_token_count(usage.get("output_tokens")))
        .or(found.output_tokens);
    let cost = json_cost_micros(usage.get("cost")).or(found.cost);
    ParsedUsage {
        input_tokens,
        output_tokens,
        cost,
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
    if let Some(n) = v.as_u64() {
        return Some(CostMicros(n));
    }
    if let Some(n) = v.as_i64() {
        return u64::try_from(n).ok().map(CostMicros);
    }
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
