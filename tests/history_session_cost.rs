use octo::history::{
    CallKind, CallProvider, CostMicros, DecisionRow, FinishedCall, History, Millis,
};

#[tokio::test]
async fn session_cost_sums_calls_and_decisions() {
    let history = History::connect("sqlite::memory:", "test-key", 4096)
        .await
        .unwrap();
    history.record_decision(DecisionRow {
        session_id: Some("sess-a".into()),
        purpose: "classify".into(),
        model: "typesafe/jev-1.13".into(),
        status: 200,
        latency_ms: 1,
        user_text: "hello".into(),
        is_hard: None,
        is_easy: None,
        is_hard_score: None,
        is_easy_score: None,
        tools_enough: None,
        complexity: Some("low"),
        choice_rule: "low".into(),
        missing_tools: None,
        request_payload: "{}".into(),
        response_payload: "{}".into(),
        cost: Some(CostMicros(250_000)),
        or_cost: Some(CostMicros(250_000)),
        upstream_cost: None,
        estimated_cost: None,
        cost_source: "openrouter".into(),
    });
    history.record(FinishedCall {
        kind: CallKind::Messages,
        provider: CallProvider::OpenRouter,
        model: Some("low".into()),
        token_hash: None,
        message: None,
        input: "in".into(),
        output: "out".into(),
        request_payload: "{}".into(),
        response_payload: "{}".into(),
        status: 200,
        latency_ms: Millis::new(1),
        request_bytes: 2,
        response_bytes: 3,
        input_tokens: None,
        output_tokens: None,
        cost: Some(CostMicros(750_000)),
        or_cost: Some(CostMicros(750_000)),
        upstream_cost: None,
        estimated_cost: None,
        cost_source: "openrouter".into(),
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
        session_id: Some("sess-a".into()),
        tier_before: Some("low".into()),
        tier_after: Some("low".into()),
        trigger: "none".into(),
    });
    history.drain().await;
    let total = history.session_cost_micros("sess-a").await.unwrap();
    assert_eq!(total, 1_000_000);
}
