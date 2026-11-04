use reqwest::Client;
use serde_json::{json, Value};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Classified {
    pub complexity: Complexity,
    pub choice_rule: &'static str,
    pub is_hard: Option<bool>,
    pub is_easy: Option<bool>,
    pub tools_enough_raw: Option<String>,
    pub tools: Vec<String>,
    pub tools_enough: bool,
    pub missing_tools: Vec<String>,
}

pub struct Asked {
    pub request_body: String,
    pub response_body: String,
    pub status: u16,
    pub latency_ms: u128,
    pub parsed: Option<Classified>,
    pub choice_rule: &'static str,
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
) -> Asked {
    let started = std::time::Instant::now();
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
                "instructions": "Read user_text and the tool list and judge this turn on its own. Simple: one obvious step, a greeting, a title, a tiny rewrite, or a single lookup. Medium: a clear goal that needs a few reads or tool calls, or an explanation of code that is already there, without design or a long investigation. Hard: unknown-cause debugging, architecture, tradeoffs, or a change that spans several parts. Answer from that text. A band is not a default.",
                "criteria": {
                    "true": "The turn is hard: unknown-cause debugging, architecture, tradeoffs, or a change across several parts.",
                    "false": "The turn is simple or medium, as defined in the instructions."
                }
            },
            "is_easy": {
                "type": "noul",
                "instructions": "Using the same reading of user_text, is this turn the simple band? Simple is one obvious step. Medium needs a few steps but has a clear goal. Hard is design, a long debug, or a wide change. Answer from the text, not from which band feels safest.",
                "criteria": {
                    "true": "The turn is simple: a greeting, a title, a tiny rewrite, or one obvious lookup.",
                    "false": "The turn is medium or hard, as defined in the instructions."
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
    let request_body = payload.to_string();
    let response = client
        .post(decisions_url)
        .bearer_auth(api_key)
        .header("content-type", "application/json")
        .body(request_body.clone())
        .send()
        .await;
    let latency_ms = started.elapsed().as_millis();
    let Ok(response) = response else {
        return Asked {
            request_body,
            response_body: String::new(),
            status: 0,
            latency_ms,
            parsed: None,
            choice_rule: "request_failed",
        };
    };
    let status = response.status().as_u16();
    let Ok(text) = response.text().await else {
        return Asked {
            request_body,
            response_body: String::new(),
            status,
            latency_ms,
            parsed: None,
            choice_rule: "request_failed",
        };
    };
    if !(200..300).contains(&status) {
        return Asked {
            request_body,
            response_body: text,
            status,
            latency_ms,
            parsed: None,
            choice_rule: "request_failed",
        };
    }
    let Ok(value) = serde_json::from_str::<Value>(&text) else {
        return Asked {
            request_body,
            response_body: text,
            status,
            latency_ms,
            parsed: None,
            choice_rule: "unparsed",
        };
    };
    let parsed = classified_from_value(&value, tool_names);
    let choice_rule = parsed.choice_rule;
    Asked {
        request_body,
        response_body: text,
        status,
        latency_ms,
        parsed: Some(parsed),
        choice_rule,
    }
}

pub fn choice(is_hard: Option<bool>, is_easy: Option<bool>) -> (Complexity, &'static str) {
    match (is_hard, is_easy) {
        (Some(true), Some(false)) => (Complexity::High, "high"),
        (Some(false), Some(true)) => (Complexity::Low, "low"),
        (Some(false), Some(false)) => (Complexity::Mid, "mid_both_false"),
        (Some(true), Some(true)) => (Complexity::Mid, "mid_both_true"),
        _ => (Complexity::Mid, "mid_unanswered"),
    }
}

fn classified_from_value(value: &Value, tool_names: &[String]) -> Classified {
    let answers = value.get("answers").unwrap_or(value);
    let is_hard = flag(answers, "is_hard");
    let is_easy = flag(answers, "is_easy");
    let (complexity, choice_rule) = choice(is_hard, is_easy);
    let missing_tools = name_list(answers, "tools_enough");
    let tools_enough_raw = raw_answer(answers, "tools_enough");
    let tools_enough = (flag(answers, "tools_enough") == Some(true) && missing_tools.is_empty())
        || current_is_empty(answers);
    Classified {
        complexity,
        choice_rule,
        is_hard,
        is_easy,
        tools_enough_raw,
        tools: tool_names.to_vec(),
        tools_enough,
        missing_tools,
    }
}

fn raw_answer(answers: &Value, name: &str) -> Option<String> {
    let answer = answers.get(name)?;
    let raw = answer
        .get("value")
        .or_else(|| answer.get("answer"))
        .unwrap_or(answer);
    Some(raw.to_string())
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

const NOUL_TRUE: f64 = 0.5;

fn flag(answers: &Value, name: &str) -> Option<bool> {
    let answer = answers.get(name)?;
    if let Some(flag) = answer.as_bool() {
        return Some(flag);
    }
    if let Some(flag) = bool_word(answer) {
        return Some(flag);
    }
    if let Some(flag) = noul_flag(answer) {
        return Some(flag);
    }
    let raw = answer.get("value").or_else(|| answer.get("answer"))?;
    if let Some(flag) = raw.as_bool() {
        return Some(flag);
    }
    if let Some(flag) = noul_flag(raw) {
        return Some(flag);
    }
    match raw.as_str()? {
        "true" => Some(true),
        "false" => Some(false),
        _ => None,
    }
}

fn bool_word(value: &Value) -> Option<bool> {
    match value.as_str()? {
        "true" => Some(true),
        "false" => Some(false),
        _ => None,
    }
}

fn noul_flag(value: &Value) -> Option<bool> {
    value
        .get("noul")
        .and_then(Value::as_f64)
        .or_else(|| value.as_f64())
        .map(|score| score >= NOUL_TRUE)
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

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{choice, classified_from_value, Complexity};

    #[test]
    fn mid_names_the_reason() {
        assert_eq!(choice(Some(false), Some(false)).1, "mid_both_false");
        assert_eq!(choice(Some(true), Some(true)).1, "mid_both_true");
        assert_eq!(choice(None, Some(false)).1, "mid_unanswered");
        assert_eq!(choice(Some(true), Some(false)), (Complexity::High, "high"));
        assert_eq!(choice(Some(false), Some(true)), (Complexity::Low, "low"));
    }

    #[test]
    fn noul_score_at_half_is_true() {
        let value = json!({
            "answers": {
                "is_easy": {"type": "noul", "noul": 0.81},
                "is_hard": {"type": "noul", "noul": 0.14},
                "tools_enough": {"type": "noul", "noul": 0.44}
            }
        });
        let row = classified_from_value(&value, &[]);
        assert_eq!(row.complexity, Complexity::Low);
        assert_eq!(row.choice_rule, "low");
        assert_eq!(row.is_easy, Some(true));
        assert_eq!(row.is_hard, Some(false));
        assert!(!row.tools_enough);

        let boundary = json!({
            "answers": {
                "is_easy": {"noul": 0.5},
                "is_hard": {"noul": 0.49}
            }
        });
        let row = classified_from_value(&boundary, &[]);
        assert_eq!((row.is_easy, row.is_hard), (Some(true), Some(false)));
        assert_eq!(row.choice_rule, "low");

        let words = json!({"is_easy": "false", "is_hard": "true"});
        let row = classified_from_value(&words, &[]);
        assert_eq!(row.choice_rule, "high");

        let missing = json!({"answers": {}});
        let row = classified_from_value(&missing, &[]);
        assert_eq!(row.choice_rule, "mid_unanswered");
    }
}
