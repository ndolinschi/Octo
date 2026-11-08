use serde_json::{json, Value};

use super::super::call_provider::CallProvider;

pub fn tagged(provider: CallProvider, payload: Value) -> Value {
    json!({
        "provider": provider.as_str(),
        "payload": payload,
    })
}

pub fn tagged_string(provider: CallProvider, payload: Value) -> String {
    serde_json::to_string(&tagged(provider, payload)).unwrap_or_else(|_| {
        json!({
            "provider": provider.as_str(),
            "payload": null,
        })
        .to_string()
    })
}
