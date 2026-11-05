use serde_json::{json, Value};

use crate::providers::llm::is_subagent;
use crate::providers::openrouter::OpenRouterModels;

use super::catalog::{self, ids_match};

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
        || text.contains("[SUGGESTION MODE:")
        || text.contains("The user stepped away and is coming back")
        || text.contains("Recap in under 40 words")
        || text.contains("2-4 word lowercase label for this job")
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

pub fn question_text(body: &Value) -> String {
    strip_question_noise(&last_user_text(body))
}

fn strip_question_noise(text: &str) -> String {
    let without_blocks = remove_tagged_blocks(text);
    strip_wrapper_tags(&without_blocks).trim().to_string()
}

fn is_wrapper_tag(name: &str) -> bool {
    name.eq_ignore_ascii_case("session") || name.eq_ignore_ascii_case("conversation")
}

fn remove_tagged_blocks(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = String::new();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] != b'<' {
            let start = i;
            while i < bytes.len() && bytes[i] != b'<' {
                i += 1;
            }
            out.push_str(&text[start..i]);
            continue;
        }
        let Some((tag_name, tag_len, self_closing)) = parse_open_tag(&text[i..]) else {
            out.push('<');
            i += 1;
            continue;
        };
        if is_wrapper_tag(&tag_name) {
            out.push_str(&text[i..i + tag_len]);
            i += tag_len;
            continue;
        }
        if self_closing {
            i += tag_len;
            continue;
        }
        let close = format!("</{tag_name}>");
        let search_from = i + tag_len;
        if let Some(rel) = find_closing_tag(&text[search_from..], &tag_name) {
            i = search_from + rel + close.len();
            continue;
        }
        out.push('<');
        i += 1;
    }
    out
}

fn find_closing_tag(haystack: &str, tag_name: &str) -> Option<usize> {
    let needle = format!("</{tag_name}>");
    if let Some(at) = haystack.find(&needle) {
        return Some(at);
    }
    let lower_needle = format!("</{}>", tag_name.to_ascii_lowercase());
    let lower_hay = haystack.to_ascii_lowercase();
    lower_hay.find(&lower_needle)
}

fn parse_open_tag(s: &str) -> Option<(String, usize, bool)> {
    if !s.starts_with('<') || s.starts_with("</") {
        return None;
    }
    let rest = &s[1..];
    let name_end = rest.find(|c: char| c.is_whitespace() || c == '>' || c == '/')?;
    if name_end == 0 {
        return None;
    }
    let name = &rest[..name_end];
    if !name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return None;
    }
    let after_name = &rest[name_end..];
    let gt = after_name.find('>')?;
    let self_closing = after_name[..gt].trim_end().ends_with('/');
    Some((name.to_string(), 1 + name_end + gt + 1, self_closing))
}

fn strip_wrapper_tags(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while !rest.is_empty() {
        let Some(at) = rest.find('<') else {
            out.push_str(rest);
            break;
        };
        out.push_str(&rest[..at]);
        rest = &rest[at..];
        if let Some((name, len, _)) = parse_open_tag(rest) {
            if is_wrapper_tag(&name) {
                rest = &rest[len..];
                continue;
            }
        }
        if let Some(name) = closing_tag_name(rest) {
            if is_wrapper_tag(name) {
                rest = &rest[2 + name.len() + 1..];
                continue;
            }
        }
        out.push('<');
        rest = &rest[1..];
    }
    out
}

fn closing_tag_name(s: &str) -> Option<&str> {
    let rest = s.strip_prefix("</")?;
    let gt = rest.find('>')?;
    let name = rest[..gt].trim();
    if name.is_empty() {
        return None;
    }
    Some(name)
}

pub fn last_user_tool_results_only(body: &Value) -> bool {
    let Some(messages) = body.get("messages").and_then(Value::as_array) else {
        return false;
    };
    for message in messages.iter().rev() {
        if message.get("role").and_then(Value::as_str) != Some("user") {
            continue;
        }
        let Some(parts) = message.get("content").and_then(Value::as_array) else {
            return false;
        };
        if parts.is_empty() {
            return false;
        }
        return parts
            .iter()
            .all(|part| part.get("type").and_then(Value::as_str) == Some("tool_result"));
    }
    false
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

pub struct ShapePlan<'a> {
    pub body: &'a Value,
    pub model: &'a str,
    pub previous_model: Option<&'a str>,
    pub models: Option<&'a OpenRouterModels>,
}

pub fn shape(plan: ShapePlan<'_>) -> Value {
    let mut copy = with_model(plan.body, plan.model);
    let model_changed = plan
        .previous_model
        .is_some_and(|previous| !ids_match(previous, plan.model));
    if model_changed {
        strip_thinking_blocks(&mut copy);
    }
    clamp_max_tokens(&mut copy, plan.models, plan.model);
    drop_unsupported_thinking(&mut copy, plan.models, plan.model);
    copy
}

fn strip_thinking_blocks(body: &mut Value) {
    let Some(messages) = body.get_mut("messages").and_then(Value::as_array_mut) else {
        return;
    };
    for message in messages {
        if message.get("role").and_then(Value::as_str) != Some("assistant") {
            continue;
        }
        let Some(parts) = message.get_mut("content").and_then(Value::as_array_mut) else {
            continue;
        };
        parts.retain(|part| {
            !matches!(
                part.get("type").and_then(Value::as_str),
                Some("thinking" | "redacted_thinking")
            )
        });
    }
}

fn clamp_max_tokens(body: &mut Value, models: Option<&OpenRouterModels>, model: &str) {
    let Some(limit) = catalog::max_completion_tokens(models, model) else {
        return;
    };
    let Some(object) = body.as_object_mut() else {
        return;
    };
    let current = object
        .get("max_tokens")
        .and_then(Value::as_u64)
        .unwrap_or(limit);
    object.insert("max_tokens".to_string(), json!(current.min(limit)));
}

fn drop_unsupported_thinking(body: &mut Value, models: Option<&OpenRouterModels>, model: &str) {
    if catalog::supports_reasoning(models, model) {
        return;
    }
    if let Some(object) = body.as_object_mut() {
        object.remove("thinking");
    }
}
