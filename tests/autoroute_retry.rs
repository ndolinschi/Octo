mod support;

use axum::{
    body::{to_bytes, Body},
    http::{header, Request, StatusCode},
};
use octo::routes;
use octo::state::AppState;
use serde_json::Value;
use support::{sample_config, spawn_status_sequence_server};
use tower::ServiceExt;

#[tokio::test]
async fn autoroute_retries_once_on_429_before_client_bytes() {
    let (addr, bodies) = spawn_status_sequence_server("/v1/messages", vec![429, 200]).await;
    let mut config = sample_config(64 * 1024);
    config.openrouter_messages_url = format!("http://{addr}/v1/messages");
    config.openrouter_decisions_url = format!("http://{addr}/v1/decisions");
    config.llm_messages_backend = "openrouter".to_string();
    config.autoroute_low_model = "low-model".into();
    config.autoroute_mid_model = "mid-model".into();
    config.autoroute_high_model = "high-model".into();
    let state = AppState::new(config).unwrap();
    let app = routes::router(state);
    let body = serde_json::json!({
        "model": "low-model",
        "max_tokens": 16,
        "metadata": {"user_id": "{\"session_id\":\"retry-sess\"}"},
        "messages": [{"role": "user", "content": "hi"}]
    });
    let request = Request::builder()
        .method("POST")
        .uri("/autoroute/v1/messages")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(serde_json::to_vec(&body).unwrap()))
        .unwrap();
    let response = app.oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let captured = bodies.lock().unwrap().clone();
    assert_eq!(captured.len(), 2, "expected exactly one retry after 429");
    let first: Value = serde_json::from_str(&captured[0]).unwrap();
    let second: Value = serde_json::from_str(&captured[1]).unwrap();
    assert_eq!(first["model"], "low-model");
    assert_eq!(second["model"], "mid-model");
}

#[tokio::test]
async fn messages_proxy_error_is_anthropic_shaped() {
    let mut config = sample_config(32);
    config.llm_messages_backend = "openrouter".to_string();
    config.openrouter_messages_url = "http://127.0.0.1:9/v1/messages".into();
    let state = AppState::new(config).unwrap();
    let app = routes::router(state);
    let request = Request::builder()
        .method("POST")
        .uri("/v1/messages")
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::AUTHORIZATION, "Bearer test-key")
        .body(Body::from(vec![0_u8; 64]))
        .unwrap();
    let response = app.oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
    let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let value: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(value["type"], "error");
    assert_eq!(value["error"]["type"], "invalid_request_error");
}
