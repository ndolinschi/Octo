use serde_json::{json, Value};

use super::common;

pub fn request(body: &str) -> Value {
    json!({
        "format": "openrouter_decisions",
        "body": common::parse_json_body(body),
    })
}

pub fn response(prefix: &str, tail: &str) -> Value {
    let body = common::parse_json_body(prefix);
    let tail_body = if tail.is_empty() {
        Value::Null
    } else {
        common::parse_json_body(tail)
    };
    json!({
        "format": "openrouter_decisions",
        "body": body,
        "tail": tail_body,
    })
}
