use reqwest::Client;
use serde_json::{json, Value};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Classified {
    pub complexity: Complexity,
    pub tools: Vec<String>,
    pub tools_enough: bool,
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
                "instructions": "Can current_tools finish this user_text?",
                "criteria": {
                    "true": "Every needed tool is already in current_tools, or no tool is needed.",
                    "false": "The text needs a tool listed in tools but missing from current_tools."
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
    let tools_enough = noul(answers, "tools_enough") || current_is_empty(answers);
    Classified {
        complexity,
        tools: tool_names.to_vec(),
        tools_enough,
    }
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

pub fn needed_tools(all: &[String], current: &[String], enough: bool) -> Vec<String> {
    if enough || current.is_empty() {
        if current.is_empty() {
            return all.to_vec();
        }
        return current.to_vec();
    }
    all.to_vec()
}
