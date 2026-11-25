use serde_json::Value;

use super::types::{Classified, Complexity, Thresholds};

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

pub fn choice_from_scores(
    hard_score: Option<f64>,
    easy_score: Option<f64>,
    thresholds: Thresholds,
) -> (Complexity, &'static str) {
    choice(
        hard_score.map(|score| score >= thresholds.hard),
        easy_score.map(|score| score >= thresholds.easy),
    )
}

pub fn classified(value: &Value, tool_names: &[String], thresholds: Thresholds) -> Classified {
    let answers = value.get("answers").unwrap_or(value);
    let is_hard_score = noul_score(answers, "is_hard");
    let is_easy_score = noul_score(answers, "is_easy");
    let (complexity, choice_rule) = choice_from_scores(is_hard_score, is_easy_score, thresholds);
    let is_hard = is_hard_score.map(|score| score >= thresholds.hard);
    let is_easy = is_easy_score.map(|score| score >= thresholds.easy);
    let missing_tools = name_list(answers, "tools_enough");
    Classified {
        complexity,
        choice_rule,
        is_hard,
        is_easy,
        is_hard_score,
        is_easy_score,
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
    noul_number(value).map(|score| score >= NOUL_TRUE)
}

pub fn noul_score(answers: &Value, name: &str) -> Option<f64> {
    let answer = answers.get(name)?;
    noul_number(answer).or_else(|| noul_number(answer_value(answer)))
}

fn noul_number(value: &Value) -> Option<f64> {
    if let Some(score) = value.get("noul").and_then(Value::as_f64) {
        return Some(score);
    }
    if let Some(score) = value.as_f64() {
        return Some(score);
    }
    match value.as_bool() {
        Some(true) => Some(1.0),
        Some(false) => Some(0.0),
        None => match value.as_str()? {
            "true" => Some(1.0),
            "false" => Some(0.0),
            text => text.parse().ok(),
        },
    }
}
