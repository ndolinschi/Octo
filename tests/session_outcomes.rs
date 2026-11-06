use octo::history::{
    parse_test_summary, parse_tool_results_outcome, CallKind, CallProvider, FinishedCall, History,
    Millis, SessionOutcome,
};
use serde_json::json;

#[test]
fn parses_cargo_summary() {
    let text = "running 2 tests\ntest a ... ok\ntest b ... ok\n\ntest result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s\n";
    assert_eq!(
        parse_test_summary(text),
        Some(SessionOutcome {
            last_test_tool: "cargo".into(),
            tests_passed: 2,
            tests_failed: 0,
            tests_errors: 0,
            last_status: "pass".into(),
        })
    );
}

#[test]
fn parses_pytest_summary() {
    let text = "===== 3 passed, 1 failed, 2 errors in 1.2s =====";
    assert_eq!(
        parse_test_summary(text),
        Some(SessionOutcome {
            last_test_tool: "pytest".into(),
            tests_passed: 3,
            tests_failed: 1,
            tests_errors: 2,
            last_status: "fail".into(),
        })
    );
}

#[test]
fn parses_unittest_summary() {
    let text = "Ran 5 tests in 0.012s\n\nFAILED (failures=1, errors=1)\n";
    assert_eq!(
        parse_test_summary(text),
        Some(SessionOutcome {
            last_test_tool: "unittest".into(),
            tests_passed: 3,
            tests_failed: 1,
            tests_errors: 1,
            last_status: "fail".into(),
        })
    );
    let ok = "Ran 2 tests in 0.001s\n\nOK\n";
    assert_eq!(parse_test_summary(ok).unwrap().last_status, "pass");
}

#[test]
fn parse_tool_results_reads_last_user_message() {
    let body = json!({
        "messages": [
            {"role": "user", "content": "run tests"},
            {"role": "assistant", "content": [{"type": "tool_use", "id": "t1", "name": "Bash"}]},
            {"role": "user", "content": [
                {"type": "tool_result", "tool_use_id": "t1", "content": "test result: FAILED. 1 passed; 2 failed; 0 ignored; 0 measured; 0 filtered out"}
            ]}
        ]
    });
    let outcome = parse_tool_results_outcome(&body.to_string()).unwrap();
    assert_eq!(outcome.last_test_tool, "cargo");
    assert_eq!(outcome.tests_failed, 2);
    assert_eq!(outcome.last_status, "fail");
}

#[tokio::test]
async fn upsert_orders_latest_outcome_per_session() {
    let history = History::connect("sqlite::memory:", "test-token-key", 64 * 1024)
        .await
        .unwrap();
    let fail = body_with_tool_result(
        "test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out",
    );
    let pass = body_with_tool_result(
        "test result: ok. 4 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out",
    );
    history.record(finished("sess-out", &fail));
    history.drain().await;
    history.record(finished("sess-out", &pass));
    history.drain().await;

    let row = sqlx::query_as::<_, (String, i64, i64, i64, String)>(
        "SELECT last_test_tool, tests_passed, tests_failed, tests_errors, last_status FROM session_outcomes WHERE session_id = ?",
    )
    .bind("sess-out")
    .fetch_one(history.pool().unwrap())
    .await
    .unwrap();
    assert_eq!(row.0, "cargo");
    assert_eq!(row.1, 4);
    assert_eq!(row.2, 0);
    assert_eq!(row.3, 0);
    assert_eq!(row.4, "pass");
}

fn body_with_tool_result(summary: &str) -> String {
    json!({
        "model": "m",
        "messages": [{
            "role": "user",
            "content": [{
                "type": "tool_result",
                "tool_use_id": "t1",
                "content": summary
            }]
        }]
    })
    .to_string()
}

fn finished(session_id: &str, input: &str) -> FinishedCall {
    FinishedCall {
        kind: CallKind::Messages,
        provider: CallProvider::OpenRouter,
        model: Some("m".into()),
        token_hash: None,
        message: None,
        input: input.to_string(),
        output: String::new(),
        request_payload: String::new(),
        response_payload: String::new(),
        status: 200,
        latency_ms: Millis::new(1),
        request_bytes: input.len(),
        response_bytes: 0,
        input_tokens: None,
        output_tokens: None,
        cost: None,
        or_cost: None,
        upstream_cost: None,
        estimated_cost: None,
        cost_source: "none".into(),
        is_byok: None,
        upstream_provider: None,
        trimmed_from_tokens: None,
        client_model: None,
        client_has_thinking: None,
        client_tool_names: None,
        bg_signal: None,
        hk_text_signal: None,
        cache_read_tokens: None,
        cache_write_tokens: None,
        generation_id: None,
        rerouting: 0,
        rerouting_reason: None,
        session_id: Some(session_id.into()),
        tier_before: Some("mid".into()),
        tier_after: Some("mid".into()),
        trigger: "classify".into(),
    }
}
