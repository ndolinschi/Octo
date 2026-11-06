use serde_json::Value;

pub fn looks_like_text_tool_call(text: &str, tools: &[&str]) -> bool {
    if tools.is_empty() || text.trim().is_empty() {
        return false;
    }
    if text_has_tool_call_tags(text, tools) {
        return true;
    }
    json_names_match_tools(text, tools)
}

pub fn assistant_text_tool_call(body: &Value) -> bool {
    let tools = tool_names(body);
    if tools.is_empty() {
        return false;
    }
    let tool_refs: Vec<&str> = tools.iter().map(String::as_str).collect();
    for message in recent_assistant_messages(body) {
        let text = content_text(message.get("content"));
        if looks_like_text_tool_call(&text, &tool_refs) {
            return true;
        }
    }
    false
}

pub fn response_has_text_tool_call(response: &str, tools: &[String]) -> bool {
    if tools.is_empty() {
        return false;
    }
    let tool_refs: Vec<&str> = tools.iter().map(String::as_str).collect();
    let combined = collect_response_text(response);
    looks_like_text_tool_call(&combined, &tool_refs)
}

fn text_has_tool_call_tags(text: &str, tools: &[&str]) -> bool {
    let lower = text.to_ascii_lowercase();
    let Some(start) = lower.find("<tool_call") else {
        return false;
    };
    let rest = &text[start..];
    let Some(end_rel) = rest.to_ascii_lowercase().find("</tool_call>") else {
        return json_names_match_tools(rest, tools);
    };
    json_names_match_tools(&rest[..end_rel], tools)
}

fn json_names_match_tools(text: &str, tools: &[&str]) -> bool {
    for candidate in json_candidates(text) {
        if let Ok(value) = serde_json::from_str::<Value>(candidate) {
            if value_names_match_tools(&value, tools) {
                return true;
            }
        }
    }
    false
}

fn value_names_match_tools(value: &Value, tools: &[&str]) -> bool {
    match value {
        Value::Array(items) => items.iter().any(|item| object_is_tool_call(item, tools)),
        Value::Object(_) => object_is_tool_call(value, tools),
        _ => false,
    }
}

fn object_is_tool_call(value: &Value, tools: &[&str]) -> bool {
    let Some(name) = value.get("name").and_then(Value::as_str) else {
        return false;
    };
    if !tools.contains(&name) {
        return false;
    }
    value.get("arguments").is_some() || value.get("input").is_some()
}

fn json_candidates(text: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let bytes = text.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        let start = match bytes[i] {
            b'{' | b'[' => i,
            _ => {
                i += 1;
                continue;
            }
        };
        let open = bytes[start];
        let close = if open == b'{' { b'}' } else { b']' };
        let mut depth = 0i32;
        let mut in_string = false;
        let mut escape = false;
        let mut j = start;
        while j < bytes.len() {
            let c = bytes[j];
            if in_string {
                if escape {
                    escape = false;
                } else if c == b'\\' {
                    escape = true;
                } else if c == b'"' {
                    in_string = false;
                }
                j += 1;
                continue;
            }
            match c {
                b'"' => in_string = true,
                b if b == open => depth += 1,
                b if b == close => {
                    depth -= 1;
                    if depth == 0 {
                        out.push(&text[start..=j]);
                        break;
                    }
                }
                _ => {}
            }
            j += 1;
        }
        i = start + 1;
    }
    out
}

fn collect_response_text(response: &str) -> String {
    if let Ok(value) = serde_json::from_str::<Value>(response) {
        return content_text(value.get("content"));
    }
    let mut text = String::new();
    for line in response.lines() {
        let Some(data) = line.strip_prefix("data: ") else {
            continue;
        };
        let Ok(event) = serde_json::from_str::<Value>(data) else {
            continue;
        };
        if event.get("type").and_then(Value::as_str) == Some("content_block_delta") {
            if let Some(piece) = event
                .get("delta")
                .and_then(|delta| delta.get("text"))
                .and_then(Value::as_str)
            {
                text.push_str(piece);
            }
        }
        if event.get("type").and_then(Value::as_str) == Some("content_block_start") {
            if let Some(piece) = event
                .get("content_block")
                .and_then(|block| block.get("text"))
                .and_then(Value::as_str)
            {
                text.push_str(piece);
            }
        }
    }
    if text.is_empty() {
        response.to_string()
    } else {
        text
    }
}

fn tool_names(body: &Value) -> Vec<String> {
    body.get("tools")
        .and_then(Value::as_array)
        .map(|tools| {
            tools
                .iter()
                .filter_map(|tool| {
                    tool.get("name")
                        .and_then(Value::as_str)
                        .or_else(|| {
                            tool.get("function")
                                .and_then(|function| function.get("name"))
                                .and_then(Value::as_str)
                        })
                        .map(str::to_string)
                })
                .collect()
        })
        .unwrap_or_default()
}

fn recent_assistant_messages(body: &Value) -> Vec<&Value> {
    let Some(messages) = body.get("messages").and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for message in messages.iter().rev() {
        if message.get("role").and_then(Value::as_str) != Some("assistant") {
            continue;
        }
        out.push(message);
        if out.len() == 2 {
            break;
        }
    }
    out
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
