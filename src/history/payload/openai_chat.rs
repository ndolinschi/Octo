use serde_json::Value;

use super::common;

pub fn request(body: &str) -> Value {
    serde_json::json!({
        "format": "openai_chat_completions",
        "body": common::parse_json_body(body),
    })
}

pub fn response(prefix: &str, tail: &str, response_bytes: usize) -> Value {
    common::streaming_response("openai_chat_completions", prefix, tail, response_bytes)
}
