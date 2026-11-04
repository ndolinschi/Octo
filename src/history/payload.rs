use serde_json::Value;

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

pub fn usage_from_output(output: &str) -> (Option<i64>, Option<i64>, Option<f64>) {
    let mut found = (None, None, None);
    merge_usage(&mut found, output);
    for line in output.lines() {
        let line = line.trim();
        let payload = line.strip_prefix("data:").map(str::trim).unwrap_or(line);
        if payload.is_empty() || payload == "[DONE]" {
            continue;
        }
        merge_usage(&mut found, payload);
    }
    found
}

fn merge_usage(found: &mut (Option<i64>, Option<i64>, Option<f64>), raw: &str) {
    let Ok(value) = serde_json::from_str::<Value>(raw) else {
        return;
    };
    apply_usage(found, value.get("usage"));
    apply_usage(
        found,
        value
            .get("message")
            .and_then(|message| message.get("usage")),
    );
}

fn apply_usage(found: &mut (Option<i64>, Option<i64>, Option<f64>), usage: Option<&Value>) {
    let Some(usage) = usage else {
        return;
    };
    if let Some(input) =
        json_i64(usage.get("prompt_tokens")).or_else(|| json_i64(usage.get("input_tokens")))
    {
        found.0 = Some(input);
    }
    if let Some(output) =
        json_i64(usage.get("completion_tokens")).or_else(|| json_i64(usage.get("output_tokens")))
    {
        found.1 = Some(output);
    }
    if let Some(cost) = usage.get("cost").and_then(Value::as_f64) {
        found.2 = Some(cost);
    }
}

fn json_i64(value: Option<&Value>) -> Option<i64> {
    value.and_then(|v| {
        v.as_i64()
            .or_else(|| v.as_u64().map(|n| n as i64))
            .or_else(|| v.as_f64().map(|n| n as i64))
    })
}
