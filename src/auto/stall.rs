use serde_json::Value;

use super::body;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StallTrigger {
    RepeatedCall,
    ErrorStreak,
    EditStreak,
}

impl StallTrigger {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::RepeatedCall => "repeated_call",
            Self::ErrorStreak => "error_streak",
            Self::EditStreak => "edit_streak",
        }
    }
}

pub fn detect(body: &Value, window: u32) -> Option<StallTrigger> {
    let window = window.max(1) as usize;
    if repeated_call(body, window) {
        return Some(StallTrigger::RepeatedCall);
    }
    if error_streak(body) {
        return Some(StallTrigger::ErrorStreak);
    }
    if edit_streak(body, window) {
        return Some(StallTrigger::EditStreak);
    }
    None
}

fn repeated_call(body: &Value, window: usize) -> bool {
    let mut counts: Vec<(String, String, usize)> = Vec::new();
    for message in recent_assistant_messages(body, window) {
        for block in content_blocks(message) {
            if block.get("type").and_then(Value::as_str) != Some("tool_use") {
                continue;
            }
            let Some(name) = block.get("name").and_then(Value::as_str) else {
                continue;
            };
            let input = normalize_json(block.get("input").unwrap_or(&Value::Null));
            if let Some(row) = counts.iter_mut().find(|(n, i, _)| n == name && i == &input) {
                row.2 += 1;
                if row.2 >= 3 {
                    return true;
                }
            } else {
                counts.push((name.to_string(), input, 1));
            }
        }
    }
    false
}

fn error_streak(body: &Value) -> bool {
    let Some(messages) = body.get("messages").and_then(Value::as_array) else {
        return false;
    };
    let mut streak = 0usize;
    for message in messages.iter().rev() {
        if message.get("role").and_then(Value::as_str) != Some("user") {
            continue;
        }
        if body::is_housekeeping(&content_text(message.get("content"))) {
            continue;
        }
        if user_has_error_tool_result(message) {
            streak += 1;
            if streak >= 3 {
                return true;
            }
        } else {
            break;
        }
    }
    false
}

fn edit_streak(body: &Value, window: usize) -> bool {
    let uses = recent_tool_uses(body, window);
    if uses.len() < window {
        return false;
    }
    uses.iter().all(|name| is_edit_like(name))
}

fn recent_assistant_messages(body: &Value, window: usize) -> Vec<&Value> {
    let Some(messages) = body.get("messages").and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for (index, message) in messages.iter().enumerate().rev() {
        if message.get("role").and_then(Value::as_str) != Some("assistant") {
            continue;
        }
        if following_user_is_housekeeping(messages, index) {
            continue;
        }
        out.push(message);
        if out.len() == window {
            break;
        }
    }
    out.reverse();
    out
}

fn following_user_is_housekeeping(messages: &[Value], assistant_index: usize) -> bool {
    messages
        .iter()
        .skip(assistant_index + 1)
        .find(|message| message.get("role").and_then(Value::as_str) == Some("user"))
        .is_some_and(|message| body::is_housekeeping(&content_text(message.get("content"))))
}

fn recent_tool_uses(body: &Value, window: usize) -> Vec<String> {
    let Some(messages) = body.get("messages").and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for (index, message) in messages.iter().enumerate().rev() {
        if message.get("role").and_then(Value::as_str) != Some("assistant") {
            continue;
        }
        if following_user_is_housekeeping(messages, index) {
            continue;
        }
        for block in content_blocks(message).into_iter().rev() {
            if block.get("type").and_then(Value::as_str) != Some("tool_use") {
                continue;
            }
            if let Some(name) = block.get("name").and_then(Value::as_str) {
                out.push(name.to_string());
                if out.len() == window {
                    out.reverse();
                    return out;
                }
            }
        }
    }
    out.reverse();
    out
}

fn user_has_error_tool_result(message: &Value) -> bool {
    let mut saw = false;
    for block in content_blocks(message) {
        if block.get("type").and_then(Value::as_str) != Some("tool_result") {
            continue;
        }
        saw = true;
        if block.get("is_error").and_then(Value::as_bool) != Some(true) {
            return false;
        }
    }
    saw
}

fn content_blocks(message: &Value) -> Vec<&Value> {
    match message.get("content") {
        Some(Value::Array(parts)) => parts.iter().collect(),
        _ => Vec::new(),
    }
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

fn is_edit_like(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.contains("edit") || lower.contains("str_replace") || lower.contains("strreplace")
}

fn normalize_json(value: &Value) -> String {
    match value {
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            let parts: Vec<String> = keys
                .into_iter()
                .map(|key| format!("{}:{}", key, normalize_json(&map[key])))
                .collect();
            format!("{{{}}}", parts.join(","))
        }
        Value::Array(items) => {
            let parts: Vec<String> = items.iter().map(normalize_json).collect();
            format!("[{}]", parts.join(","))
        }
        Value::String(text) => format!("\"{text}\""),
        other => other.to_string(),
    }
}
