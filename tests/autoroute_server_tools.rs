mod support;

use axum::{
    body::{to_bytes, Body},
    http::{header, Request, StatusCode},
};
use octo::auto::Tiers;
use octo::routes;
use octo::state::AppState;
use serde_json::{json, Value};
use support::{sample_config, spawn_status_sequence_server};
use tower::ServiceExt;

fn server_tool_body() -> Value {
    json!({
        "model": "claude-sonnet-4-5",
        "max_tokens": 16,
        "metadata": {"user_id": "{\"session_id\":\"server-tool-sess\"}"},
        "tools": [
            {"type": "web_search_20250305"},
            {"name": "Read", "input_schema": {"type": "object"}}
        ],
        "messages": [{"role": "user", "content": "search the docs"}]
    })
}

#[tokio::test]
async fn server_tool_reject_returns_anthropic_400() {
    let mut config = sample_config(64 * 1024);
    config.autoroute_server_tool_mode = "reject".into();
    config.autoroute_low_model = "low-m".into();
    config.autoroute_mid_model = "mid-m".into();
    config.autoroute_high_model = "high-m".into();
    let state = AppState::new(config).unwrap();
    let app = routes::router(state);
    let request = Request::builder()
        .method("POST")
        .uri("/autoroute/v1/messages")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(serde_json::to_vec(&server_tool_body()).unwrap()))
        .unwrap();
    let response = app.oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let value: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(value["type"], "error");
    assert_eq!(value["error"]["type"], "invalid_request_error");
    let message = value["error"]["message"].as_str().unwrap_or("");
    assert!(
        message.contains("web_search_20250305"),
        "reject message should name the tool: {message}"
    );
}

#[tokio::test]
async fn server_tool_online_suffix_appends_to_outgoing_model() {
    let (addr, bodies) = spawn_status_sequence_server("/v1/messages", vec![200]).await;
    let mut config = sample_config(64 * 1024);
    config.openrouter_messages_url = format!("http://{addr}/v1/messages");
    config.openrouter_decisions_url = format!("http://{addr}/v1/decisions");
    config.llm_messages_backend = "openrouter".to_string();
    config.autoroute_server_tool_mode = "online_suffix".into();
    config.autoroute_low_model = "low-m".into();
    config.autoroute_mid_model = "mid-m".into();
    config.autoroute_high_model = "high-m".into();
    let state = AppState::new(config).unwrap();
    state.auto.seed_session(
        "server-tool-sess",
        octo::auto::SessionChoice::fresh("mid-m".into(), vec!["Read".into()], "mid".into()),
    );
    let app = routes::router(state);
    let request = Request::builder()
        .method("POST")
        .uri("/autoroute/v1/messages")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(serde_json::to_vec(&server_tool_body()).unwrap()))
        .unwrap();
    let response = app.oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let captured = bodies.lock().unwrap().clone();
    assert_eq!(captured.len(), 1);
    let payload: Value = serde_json::from_str(&captured[0]).unwrap();
    assert_eq!(payload["model"], "mid-m:online");
}

#[tokio::test]
async fn server_tool_online_suffix_survives_tier_retry() {
    let (addr, bodies) = spawn_status_sequence_server("/v1/messages", vec![429, 200]).await;
    let mut config = sample_config(64 * 1024);
    config.openrouter_messages_url = format!("http://{addr}/v1/messages");
    config.openrouter_decisions_url = format!("http://{addr}/v1/decisions");
    config.llm_messages_backend = "openrouter".to_string();
    config.autoroute_server_tool_mode = "online_suffix".into();
    config.autoroute_low_model = "low-m".into();
    config.autoroute_mid_model = "mid-m".into();
    config.autoroute_high_model = "high-m".into();
    let state = AppState::new(config).unwrap();
    state.auto.seed_session(
        "server-tool-sess",
        octo::auto::SessionChoice::fresh("low-m".into(), vec!["Read".into()], "low".into()),
    );
    let app = routes::router(state);
    let mut body = server_tool_body();
    body["model"] = json!("claude-haiku-4-5");
    let request = Request::builder()
        .method("POST")
        .uri("/autoroute/v1/messages")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(serde_json::to_vec(&body).unwrap()))
        .unwrap();
    let response = app.oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let captured = bodies.lock().unwrap().clone();
    assert_eq!(
        captured.len(),
        2,
        "expected retry after 429 with online_suffix"
    );
    let first: Value = serde_json::from_str(&captured[0]).unwrap();
    let second: Value = serde_json::from_str(&captured[1]).unwrap();
    assert_eq!(first["model"], "low-m:online");
    assert_eq!(second["model"], "mid-m:online");
}

#[test]
fn next_up_ignores_online_suffix() {
    let tiers = Tiers::new("low-m".into(), "mid-m".into(), "high-m".into());
    assert_eq!(tiers.band("mid-m:online"), "mid");
    assert_eq!(tiers.next_up("mid-m:online").as_deref(), Some("high-m"));
    assert_eq!(tiers.next_up("low-m:online").as_deref(), Some("mid-m"));
}
