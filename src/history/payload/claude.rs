use serde_json::Value;

use super::common;

pub fn request(body: &str) -> Value {
    serde_json::json!({
        "format": "anthropic_messages",
        "body": common::parse_json_body(body),
    })
}

pub fn response(prefix: &str, tail: &str, response_bytes: usize) -> Value {
    common::streaming_response("anthropic_messages", prefix, tail, response_bytes)
}
