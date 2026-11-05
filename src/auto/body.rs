use serde_json::{json, Value};

use crate::providers::llm::is_subagent;

pub fn session_id(body: &Value) -> Option<String> {
    let raw = body.get("metadata")?.get("user_id")?;
    let text = raw.as_str()?;
    let parsed: Value = serde_json::from_str(text).ok()?;
    parsed
        .get("session_id")
        .and_then(Value::as_str)
        .map(str::to_string)
}

pub fn session_key(body: &Value) -> Option<String> {
    let id = session_id(body)?;
    if is_subagent(body) {
        Some(format!("{id}#subagent"))
    } else {
        Some(id)
    }
}

pub fn is_housekeeping(text: &str) -> bool {
    text.contains("Write the title in the predominant language")
        || text.contains("Describe your most recent action")
        || text.contains("[SYSTEM NOTIFICATION - NOT USER INPUT]")
        || text.contains("Current state: working")
}

pub fn last_user_text(body: &Value) -> String {
    let Some(messages) = body.get("messages").and_then(Value::as_array) else {
        return String::new();
    };
    for message in messages.iter().rev() {
        if message.get("role").and_then(Value::as_str) != Some("user") {
            continue;
        }
        return content_text(message.get("content"));
    }
    String::new()
}

fn content_text(content: Option<&Value>) -> String {
    let Some(content) = content else {
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

pub fn tool_names(body: &Value) -> Vec<String> {
    body.get("tools")
        .and_then(Value::as_array)
        .map(|tools| {
            tools
                .iter()
                .filter_map(|tool| tool_name(tool).map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

pub fn max_tokens(body: &Value) -> u64 {
    body.get("max_tokens")
        .and_then(Value::as_u64)
        .unwrap_or(4096)
}

pub fn preferred_model(body: &Value) -> Option<String> {
    body.get("model")
        .and_then(Value::as_str)
        .map(str::to_string)
}

pub fn filter_tools(body: &mut Value, keep: &[String]) {
    let Some(tools) = body.get_mut("tools").and_then(Value::as_array_mut) else {
        return;
    };
    tools.retain(|tool| tool_name(tool).is_some_and(|name| keep.iter().any(|kept| kept == name)));
}

fn tool_name(tool: &Value) -> Option<&str> {
    tool.get("name").and_then(Value::as_str).or_else(|| {
        tool.get("function")
            .and_then(|function| function.get("name"))
            .and_then(Value::as_str)
    })
}

pub fn with_model(body: &Value, model: &str) -> Value {
    let mut copy = body.clone();
    if let Some(object) = copy.as_object_mut() {
        object.insert("model".to_string(), json!(model));
    }
    copy
}

pub fn compaction_body(body: &Value, model: &str) -> Value {
    let mut copy = with_model(body, model);
    if let Some(object) = copy.as_object_mut() {
        object.insert("compaction".to_string(), json!({"type": "summarize"}));
        object.insert("stream".to_string(), json!(false));
    }
    copy
}
