use serde_json::Value;
use sqlx::SqlitePool;

use super::error::HistoryError;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionOutcome {
    pub last_test_tool: String,
    pub tests_passed: i64,
    pub tests_failed: i64,
    pub tests_errors: i64,
    pub last_status: String,
}

pub fn parse_tool_results_outcome(request_body: &str) -> Option<SessionOutcome> {
    let value: Value = serde_json::from_str(request_body).ok()?;
    let root = value.get("body").cloned().unwrap_or(value);
    let messages = root.get("messages")?.as_array()?;
    for message in messages.iter().rev() {
        if message.get("role").and_then(Value::as_str) != Some("user") {
            continue;
        }
        let texts = tool_result_texts(message);
        if texts.is_empty() {
            return None;
        }
        for text in &texts {
            if let Some(outcome) = parse_test_summary(text) {
                return Some(outcome);
            }
        }
        return None;
    }
    None
}

fn tool_result_texts(message: &Value) -> Vec<String> {
    let Some(parts) = message.get("content").and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for part in parts {
        if part.get("type").and_then(Value::as_str) != Some("tool_result") {
            continue;
        }
        out.push(content_as_text(part.get("content")));
    }
    out
}

fn content_as_text(content: Option<&Value>) -> String {
    let Some(content) = content else {
        return String::new();
    };
    if let Some(text) = content.as_str() {
        return text.to_string();
    }
    if let Some(parts) = content.as_array() {
        let mut text = String::new();
        for part in parts {
            if let Some(piece) = part.get("text").and_then(Value::as_str) {
                text.push_str(piece);
            } else if let Some(piece) = part.as_str() {
                text.push_str(piece);
            }
        }
        return text;
    }
    content.to_string()
}

pub fn parse_test_summary(text: &str) -> Option<SessionOutcome> {
    parse_cargo(text)
        .or_else(|| parse_pytest(text))
        .or_else(|| parse_unittest(text))
}

fn parse_cargo(text: &str) -> Option<SessionOutcome> {
    let line = text.lines().rev().find(|line| line.contains("test result:"))?;
    let passed = number_before(line, "passed").unwrap_or(0);
    let failed = number_before(line, "failed").unwrap_or(0);
    let errors = number_before(line, "error").unwrap_or(0);
    if passed == 0 && failed == 0 && errors == 0 && !line.contains("passed") {
        return None;
    }
    Some(SessionOutcome {
        last_test_tool: "cargo".to_string(),
        tests_passed: passed,
        tests_failed: failed,
        tests_errors: errors,
        last_status: status_label(failed, errors, line.contains("ok.")),
    })
}

fn parse_pytest(text: &str) -> Option<SessionOutcome> {
    let lower = text.to_ascii_lowercase();
    if !(text.contains("===") || lower.contains("pytest")) {
        return None;
    }
    let mut passed = 0;
    let mut failed = 0;
    let mut errors = 0;
    let mut found = false;
    for line in text.lines() {
        if let Some(n) = number_before(line, "passed") {
            passed = n;
            found = true;
        }
        if let Some(n) = number_before(line, "failed") {
            failed = n;
            found = true;
        }
        if let Some(n) = number_before(line, "error") {
            errors = n;
            found = true;
        } else if let Some(n) = number_before(line, "errors") {
            errors = n;
            found = true;
        }
    }
    if !found {
        return None;
    }
    Some(SessionOutcome {
        last_test_tool: "pytest".to_string(),
        tests_passed: passed,
        tests_failed: failed,
        tests_errors: errors,
        last_status: status_label(failed, errors, failed == 0 && errors == 0 && passed > 0),
    })
}

fn parse_unittest(text: &str) -> Option<SessionOutcome> {
    let ran = text.lines().find_map(|line| {
        let rest = line.trim().strip_prefix("Ran ")?;
        rest.split_whitespace().next()?.parse::<i64>().ok()
    })?;
    let failed = capture_after(text, "failures=").unwrap_or(0);
    let errors = capture_after(text, "errors=").unwrap_or(0);
    let ok = text
        .lines()
        .any(|line| line.trim() == "OK" || line.trim().starts_with("OK ("));
    let passed = (ran - failed - errors).max(0);
    Some(SessionOutcome {
        last_test_tool: "unittest".to_string(),
        tests_passed: passed,
        tests_failed: failed,
        tests_errors: errors,
        last_status: status_label(failed, errors, ok),
    })
}

fn status_label(failed: i64, errors: i64, ok_hint: bool) -> String {
    if failed > 0 || errors > 0 {
        "fail".to_string()
    } else if ok_hint {
        "pass".to_string()
    } else {
        "unknown".to_string()
    }
}

fn number_before(line: &str, word: &str) -> Option<i64> {
    let tokens: Vec<&str> = line
        .split(|c: char| c.is_whitespace() || c == ',' || c == ';')
        .filter(|t| !t.is_empty())
        .collect();
    for window in tokens.windows(2) {
        if window[1] == word || window[1].starts_with(word) {
            return window[0]
                .trim_matches(|c: char| !c.is_ascii_digit())
                .parse()
                .ok();
        }
    }
    None
}

fn capture_after(text: &str, prefix: &str) -> Option<i64> {
    let idx = text.find(prefix)?;
    let rest = &text[idx + prefix.len()..];
    let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
    digits.parse().ok()
}

pub async fn upsert_session_outcome(
    pool: &SqlitePool,
    session_id: &str,
    outcome: &SessionOutcome,
) -> Result<(), HistoryError> {
    let now = now_secs();
    sqlx::query(
        r#"
        INSERT INTO session_outcomes (
            session_id, updated_at, last_test_tool, tests_passed, tests_failed, tests_errors, last_status
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET
            updated_at = excluded.updated_at,
            last_test_tool = excluded.last_test_tool,
            tests_passed = excluded.tests_passed,
            tests_failed = excluded.tests_failed,
            tests_errors = excluded.tests_errors,
            last_status = excluded.last_status
        "#,
    )
    .bind(session_id)
    .bind(now)
    .bind(&outcome.last_test_tool)
    .bind(outcome.tests_passed)
    .bind(outcome.tests_failed)
    .bind(outcome.tests_errors)
    .bind(&outcome.last_status)
    .execute(pool)
    .await?;
    Ok(())
}

fn now_secs() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}
