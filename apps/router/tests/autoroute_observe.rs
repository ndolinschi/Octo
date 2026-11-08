mod support;

use std::time::Duration;

use axum::{
    body::{to_bytes, Body},
    http::{header, Request, StatusCode},
};
use octo::history::History;
use octo::routes;
use octo::state::AppState;
use serde_json::{json, Value};
use support::{sample_config, spawn_status_sequence_server};
use tower::ServiceExt;

#[tokio::test]
async fn autoroute_persists_client_observe_before_model_rewrite() {
    let (addr, bodies) = spawn_status_sequence_server("/v1/messages", vec![200]).await;
    let history = History::connect("sqlite::memory:", "test-token-key", 64 * 1024)
        .await
        .unwrap();
    let mut config = sample_config(64 * 1024);
    config.openrouter_messages_url = format!("http://{addr}/v1/messages");
    config.openrouter_decisions_url = format!("http://{addr}/v1/decisions");
    config.llm_messages_backend = "openrouter".to_string();
    config.autoroute_low_model = "low-m".into();
    config.autoroute_mid_model = "mid-m".into();
    config.autoroute_high_model = "high-m".into();
    let mut state = AppState::new(config).unwrap();
    state.history = history.clone();
    state.auto.seed_session(
        "observe-e2e",
        octo::auto::SessionChoice::fresh("mid-m".into(), vec!["Read".into()], "mid".into()),
    );
    let app = routes::router(state);
    let body = json!({
        "model": "claude-haiku-4-5-20251001",
        "max_tokens": 16,
        "thinking": {"type": "enabled"},
        "metadata": {"user_id": "{\"session_id\":\"observe-e2e\"}"},
        "tools": [
            {"name": "Bash", "input_schema": {"type": "object"}},
            {"name": "Read", "input_schema": {"type": "object"}}
        ],
        "messages": [{"role": "user", "content": "what is the port?"}]
    });
    let request = Request::builder()
        .method("POST")
        .uri("/autoroute/v1/messages")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(serde_json::to_vec(&body).unwrap()))
        .unwrap();
    let response = app.oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let _ = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let captured = bodies.lock().unwrap().clone();
    assert_eq!(captured.len(), 1);
    let outgoing: Value = serde_json::from_str(&captured[0]).unwrap();
    assert_eq!(outgoing["model"], "mid-m");
    history.drain().await;
    let row = poll_observe(&history).await;
    assert_eq!(row.0.as_deref(), Some("claude-haiku-4-5-20251001"));
    assert_eq!(row.1, Some(1));
    assert!(row.2.as_deref().unwrap_or("").contains("Bash"));
    assert!(row.2.as_deref().unwrap_or("").contains("Read"));
    assert_eq!(row.3, Some(1));
    assert_eq!(row.4, Some(0));
    assert_eq!(row.5.as_deref(), Some("mid-m"));
}

async fn poll_observe(
    history: &History,
) -> (
    Option<String>,
    Option<i64>,
    Option<String>,
    Option<i64>,
    Option<i64>,
    Option<String>,
) {
    for _ in 0..50 {
        let row = sqlx::query(
            "SELECT client_model, client_has_thinking, client_tool_names, bg_signal, hk_text_signal, model FROM calls",
        )
        .fetch_optional(history.pool().unwrap())
        .await
        .unwrap();
        if let Some(row) = row {
            use sqlx::Row;
            return (
                row.get("client_model"),
                row.get("client_has_thinking"),
                row.get("client_tool_names"),
                row.get("bg_signal"),
                row.get("hk_text_signal"),
                row.get("model"),
            );
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("observe history row missing");
}
