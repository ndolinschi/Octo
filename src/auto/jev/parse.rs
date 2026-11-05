use serde_json::Value;

use super::types::{Classified, Complexity};

const NOUL_TRUE: f64 = 0.5;

pub fn choice(is_hard: Option<bool>, is_easy: Option<bool>) -> (Complexity, &'static str) {
    match (is_hard, is_easy) {
        (Some(true), Some(false)) => (Complexity::High, "high"),
        (Some(false), Some(true)) => (Complexity::Low, "low"),
        (Some(false), Some(false)) => (Complexity::Mid, "mid_both_false"),
        (Some(true), Some(true)) => (Complexity::Mid, "mid_both_true"),
        _ => (Complexity::Mid, "mid_unanswered"),
    }
}

pub fn classified(value: &Value, tool_names: &[String]) -> Classified {
    let answers = value.get("answers").unwrap_or(value);
    let is_hard = flag(answers, "is_hard");
    let is_easy = flag(answers, "is_easy");
    let (complexity, choice_rule) = choice(is_hard, is_easy);
    let missing_tools = name_list(answers, "tools_enough");
    Classified {
        complexity,
        choice_rule,
        is_hard,
        is_easy,
        tools_enough_raw: raw_answer(answers, "tools_enough"),
        tools: tool_names.to_vec(),
        tools_enough: tools_cover(answers, &missing_tools),
        missing_tools,
    }
}

fn tools_cover(answers: &Value, missing_tools: &[String]) -> bool {
    (flag(answers, "tools_enough") == Some(true) && missing_tools.is_empty())
        || answers.get("tools_enough").is_none()
}

fn raw_answer(answers: &Value, name: &str) -> Option<String> {
    let answer = answers.get(name)?;
    Some(answer_value(answer).to_string())
}

fn name_list(answers: &Value, name: &str) -> Vec<String> {
    let Some(answer) = answers.get(name) else {
        return Vec::new();
    };
    names_from(answer_value(answer))
}

fn names_from(raw: &Value) -> Vec<String> {
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
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .map(str::to_string)
        .collect()
}

fn answer_value(answer: &Value) -> &Value {
    answer
        .get("value")
        .or_else(|| answer.get("answer"))
        .unwrap_or(answer)
}

fn flag(answers: &Value, name: &str) -> Option<bool> {
    as_bool(answers.get(name)?)
}

fn as_bool(answer: &Value) -> Option<bool> {
    direct_bool(answer).or_else(|| direct_bool(answer_value(answer)))
}

fn direct_bool(value: &Value) -> Option<bool> {
    value
        .as_bool()
        .or_else(|| bool_word(value))
        .or_else(|| noul_flag(value))
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

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{choice, classified, Complexity};

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
        let row = classified(&value, &[]);
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
        let row = classified(&boundary, &[]);
        assert_eq!((row.is_easy, row.is_hard), (Some(true), Some(false)));
        assert_eq!(row.choice_rule, "low");

        let words = json!({"is_easy": "false", "is_hard": "true"});
        let row = classified(&words, &[]);
        assert_eq!(row.choice_rule, "high");

        let missing = json!({"answers": {}});
        let row = classified(&missing, &[]);
        assert_eq!(row.choice_rule, "mid_unanswered");
    }
}
