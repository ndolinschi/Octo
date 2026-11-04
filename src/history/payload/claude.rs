use serde_json::{json, Value};

use super::common;

pub fn request(body: &str) -> Value {
    json!({
        "format": "anthropic_messages",
        "body": common::parse_json_body(body),
    })
}

pub fn response(prefix: &str, tail: &str) -> Value {
    let mut events = common::sse_events(prefix);
    for event in common::sse_events(tail) {
        events.push(event);
    }
    json!({
        "format": "anthropic_messages",
        "events": events,
    })
}
