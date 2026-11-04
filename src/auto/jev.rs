use reqwest::Client;
use serde_json::{json, Value};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Classified {
    pub complexity: Complexity,
    pub tools: Vec<String>,
    pub tools_enough: bool,
    pub missing_tools: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Complexity {
    Low,
    Mid,
    High,
}

pub async fn classify(
    client: &Client,
    decisions_url: &str,
    api_key: &str,
    user_text: &str,
    tool_names: &[String],
    current_tools: &[String],
) -> Option<Classified> {
    let payload = json!({
        "model": "typesafe/jev-1.13",
        "state": {
            "user_text": user_text,
            "tools": tool_names,
            "current_tools": current_tools,
        },
        "questions": {
            "is_hard": {
                "type": "noul",
                "instructions": "Is this turn a hard coding or reasoning task?",
                "criteria": {
                    "true": "Multi-step coding, debugging, or architecture.",
                    "false": "Short reply, lookup, or a small edit."
                }
            },
            "is_easy": {
                "type": "noul",
                "instructions": "Is this turn small enough for the cheapest model?",
                "criteria": {
                    "true": "Greeting, tiny rewrite, or one obvious lookup.",
                    "false": "Needs planning or several tools."
                }
            },
            "tools_enough": {
                "type": "noul",
                "instructions": "Can current_tools finish this user_text? If false, the value may be a comma-separated list of missing tool names from tools.",
                "criteria": {
                    "true": "Every needed tool is already in current_tools, or no tool is needed.",
                    "false": "Name each tool in tools that is missing from current_tools, comma-separated."
                }
            }
        }
    });
    let response = client
        .post(decisions_url)
        .bearer_auth(api_key)
        .header("content-type", "application/json")
        .body(payload.to_string())
        .send()
        .await
        .ok()?
        .error_for_status()
        .ok()?;
    let text = response.text().await.ok()?;
    let value: Value = serde_json::from_str(&text).ok()?;
    Some(classified_from_value(&value, tool_names))
}

fn classified_from_value(value: &Value, tool_names: &[String]) -> Classified {
    let answers = value.get("answers").unwrap_or(value);
    let hard = noul(answers, "is_hard");
    let easy = noul(answers, "is_easy");
    let complexity = if hard && !easy {
        Complexity::High
    } else if easy && !hard {
        Complexity::Low
    } else {
        Complexity::Mid
    };
    let missing_tools = name_list(answers, "tools_enough");
    let tools_enough =
        (noul(answers, "tools_enough") && missing_tools.is_empty()) || current_is_empty(answers);
    Classified {
        complexity,
        tools: tool_names.to_vec(),
        tools_enough,
        missing_tools,
    }
}

fn name_list(answers: &Value, name: &str) -> Vec<String> {
    let Some(answer) = answers.get(name) else {
        return Vec::new();
    };
    let raw = answer
        .get("value")
        .or_else(|| answer.get("answer"))
        .unwrap_or(answer);
    if let Some(items) = raw.as_array() {
        return items
            .iter()
            .filter_map(|item| item.as_str().map(str::to_string))
            .collect();
    }
    let Some(text) = raw.as_str() else {
        return Vec::new();
    };
    if text == "true" || text == "false" {
        return Vec::new();
    }
    text.split(',')
        .map(|part| part.trim().to_string())
        .filter(|part| !part.is_empty())
        .collect()
}

fn current_is_empty(answers: &Value) -> bool {
    answers.get("tools_enough").is_none()
}

fn noul(answers: &Value, name: &str) -> bool {
    let Some(answer) = answers.get(name) else {
        return false;
    };
    if let Some(flag) = answer.as_bool() {
        return flag;
    }
    answer
        .get("value")
        .or_else(|| answer.get("answer"))
        .and_then(|v| v.as_bool().or_else(|| v.as_str().map(|s| s == "true")))
        .unwrap_or(false)
}

pub fn needed_tools(
    all: &[String],
    current: &[String],
    enough: bool,
    missing: &[String],
) -> Vec<String> {
    if current.is_empty() {
        let named: Vec<String> = missing
            .iter()
            .filter(|name| all.iter().any(|tool| tool == *name))
            .cloned()
            .collect();
        if named.is_empty() {
            return all.to_vec();
        }
        return named;
    }
    if enough {
        return current.to_vec();
    }
    if missing.is_empty() {
        return all.to_vec();
    }
    let mut tools = current.to_vec();
    for name in missing {
        if all.iter().any(|tool| tool == name) && !tools.iter().any(|tool| tool == name) {
            tools.push(name.clone());
        }
    }
    tools
}
