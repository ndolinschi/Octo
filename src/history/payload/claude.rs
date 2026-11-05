use serde_json::Value;

use super::common;

pub fn is_subagent(body: &Value) -> bool {
    system_text(body).lines().any(|line| {
        let Some((_, header)) = line.trim().split_once("x-anthropic-billing-header:") else {
            return false;
        };
        header
            .split(';')
            .any(|part| part.trim() == "cc_is_subagent=true")
    })
}

fn system_text(body: &Value) -> String {
    let Some(content) = body.get("system") else {
        return String::new();
    };
    if let Some(text) = content.as_str() {
        return text.to_string();
    }
    let Some(parts) = content.as_array() else {
        return String::new();
    };
    let mut text = String::new();
    for part in parts {
        if let Some(piece) = part.get("text").and_then(Value::as_str) {
            text.push_str(piece);
        } else if let Some(piece) = part.as_str() {
            text.push_str(piece);
        }
    }
    text
}

pub fn request(body: &str) -> Value {
    serde_json::json!({
        "format": "anthropic_messages",
        "body": common::parse_json_body(body),
    })
}

pub fn response(prefix: &str, tail: &str, response_bytes: usize) -> Value {
    common::streaming_response("anthropic_messages", prefix, tail, response_bytes)
}
