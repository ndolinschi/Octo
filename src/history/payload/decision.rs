use serde_json::{json, Value};

use super::common;

pub fn request(body: &str) -> Value {
    json!({
        "format": "openrouter_decisions",
        "body": common::parse_json_body(body),
    })
}

pub fn response(prefix: &str, tail: &str, response_bytes: usize) -> Value {
    let suffix = common::tail_suffix_bytes(prefix.as_bytes(), tail.as_bytes(), response_bytes);
    let tail_body = if suffix.is_empty() {
        Value::Null
    } else {
        common::parse_json_body(&String::from_utf8_lossy(suffix))
    };
    json!({
        "format": "openrouter_decisions",
        "body": common::parse_json_body(prefix),
        "tail": tail_body,
    })
}
