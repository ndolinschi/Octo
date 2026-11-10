mod support;

use std::time::{Duration, SystemTime};

use axum::{
    body::{to_bytes, Body},
    http::{header, Request, StatusCode},
};
use octo::config::Config;
use octo::proxy::autoroute::retry::{model_unavailable, retry_after_delay};
use octo::routes;
use octo::state::AppState;
use serde_json::{json, Value};
use support::{sample_config, spawn_scripted_server, Captured, Scripted};
use tower::ServiceExt;

fn retry_config(addr: std::net::SocketAddr) -> Config {
    let mut config = sample_config(64 * 1024);
    config.openrouter_messages_url = format!("http://{addr}/v1/messages");
    config.openrouter_decisions_url = format!("http://{addr}/v1/decisions");
    config.llm_messages_backend = "openrouter".to_string();
    config.autoroute_low_model = "low-model".into();
    config.autoroute_mid_model = "mid-model".into();
    config.autoroute_high_model = "high-model".into();
    config
}

async fn post_messages(
    state: AppState,
    body: Value,
    extra: &[(&str, &str)],
) -> (StatusCode, Vec<u8>) {
    let app = routes::router(state);
    let mut builder = Request::builder()
        .method("POST")
        .uri("/autoroute/v1/messages")
        .header(header::CONTENT_TYPE, "application/json");
    for (name, value) in extra {
        builder = builder.header(*name, *value);
    }
    let request = builder
        .body(Body::from(serde_json::to_vec(&body).unwrap()))
        .unwrap();
    let response = app.oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    (status, bytes.to_vec())
}

fn first_turn(model: &str, session: &str) -> Value {
    json!({
        "model": model,
        "max_tokens": 16,
        "metadata": {"user_id": format!("{{\"session_id\":\"{session}\"}}")},
        "messages": [{"role": "user", "content": "hi"}]
    })
}

fn models(captured: &[Captured]) -> Vec<String> {
    captured
        .iter()
        .map(|row| row.json()["model"].as_str().unwrap_or_default().to_string())
        .collect()
}

#[tokio::test]
async fn autoroute_retries_same_tier_once_on_429() {
    let (addr, captured) =
        spawn_scripted_server("/v1/messages", vec![Scripted::status(429), Scripted::ok()]).await;
    let state = AppState::new(retry_config(addr)).unwrap();
    let (status, _) = post_messages(state, first_turn("low-model", "retry-sess"), &[]).await;
    assert_eq!(status, StatusCode::OK);
    let captured = captured.lock().unwrap().clone();
    assert_eq!(models(&captured), ["low-model", "low-model"]);
}

#[tokio::test]
async fn autoroute_retry_is_bounded_to_one_attempt() {
    let (addr, captured) = spawn_scripted_server(
        "/v1/messages",
        vec![
            Scripted::status(503),
            Scripted::status(503),
            Scripted::status(503),
        ],
    )
    .await;
    let state = AppState::new(retry_config(addr)).unwrap();
    let (status, _) = post_messages(state, first_turn("low-model", "retry-bound"), &[]).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(captured.lock().unwrap().len(), 2);
}

#[tokio::test]
async fn autoroute_escalates_tier_when_model_is_unavailable() {
    let (addr, captured) = spawn_scripted_server(
        "/v1/messages",
        vec![
            Scripted::status(503)
                .with_body(r#"{"error":{"message":"No available model provider meets your routing requirements"}}"#),
            Scripted::ok(),
        ],
    )
    .await;
    let state = AppState::new(retry_config(addr)).unwrap();
    let (status, _) = post_messages(state, first_turn("low-model", "retry-unavail"), &[]).await;
    assert_eq!(status, StatusCode::OK);
    let captured = captured.lock().unwrap().clone();
    assert_eq!(models(&captured), ["low-model", "mid-model"]);
}

#[tokio::test]
async fn autoroute_never_retries_non_retryable_4xx() {
    for status in [400_u16, 401, 403, 404, 422] {
        let (addr, captured) = spawn_scripted_server(
            "/v1/messages",
            vec![Scripted::status(status), Scripted::ok()],
        )
        .await;
        let state = AppState::new(retry_config(addr)).unwrap();
        let (got, _) = post_messages(state, first_turn("low-model", "retry-4xx"), &[]).await;
        assert_eq!(got.as_u16(), status);
        assert_eq!(captured.lock().unwrap().len(), 1, "status {status}");
    }
}

#[tokio::test]
async fn autoroute_honours_retry_after_seconds_before_retry() {
    let (addr, captured) = spawn_scripted_server(
        "/v1/messages",
        vec![
            Scripted::status(429).with_header("retry-after", "1"),
            Scripted::ok(),
        ],
    )
    .await;
    let state = AppState::new(retry_config(addr)).unwrap();
    let (status, _) = post_messages(state, first_turn("low-model", "retry-after"), &[]).await;
    assert_eq!(status, StatusCode::OK);
    let captured = captured.lock().unwrap().clone();
    assert_eq!(captured.len(), 2);
    let gap = captured[1].at.duration_since(captured[0].at);
    assert!(gap >= Duration::from_millis(900), "gap was {gap:?}");
}

#[tokio::test]
async fn autoroute_bounds_retry_after_by_configured_maximum() {
    let (addr, captured) = spawn_scripted_server(
        "/v1/messages",
        vec![
            Scripted::status(429).with_header("retry-after", "3600"),
            Scripted::ok(),
        ],
    )
    .await;
    let mut config = retry_config(addr);
    config.autoroute_retry_after_max_secs = 1;
    let state = AppState::new(config).unwrap();
    let started = std::time::Instant::now();
    let (status, _) = post_messages(state, first_turn("low-model", "retry-cap"), &[]).await;
    assert_eq!(status, StatusCode::OK);
    assert!(started.elapsed() < Duration::from_secs(5));
    assert_eq!(captured.lock().unwrap().len(), 2);
}

#[tokio::test]
async fn autoroute_does_not_escalate_unavailable_model_past_budget() {
    let (addr, captured) = spawn_scripted_server(
        "/v1/messages",
        vec![
            Scripted::status(503).with_body("model is unavailable"),
            Scripted::ok(),
        ],
    )
    .await;
    let mut config = retry_config(addr);
    config.autoroute_session_budget_usd = 1.0;
    let state = AppState::new(config).unwrap();
    state.auto.seed_session(
        "retry-budget",
        octo::auto::SessionChoice::fresh("mid-model".into(), vec!["Bash".into()], "mid".into()),
    );
    state
        .auto
        .add_session_cost("retry-budget", state.auto.tiers().session_budget_micros);
    let body = json!({
        "model": "mid-model",
        "max_tokens": 16,
        "metadata": {"user_id": "{\"session_id\":\"retry-budget\"}"},
        "tools": [{"name": "Bash"}],
        "messages": [{"role": "user", "content": [{"type": "tool_result", "tool_use_id": "1", "content": "ok"}]}]
    });
    let (status, _) = post_messages(state, body, &[]).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    let captured = captured.lock().unwrap().clone();
    assert_eq!(models(&captured), ["mid-model"]);
}

#[test]
fn retry_after_parses_seconds_and_http_dates_with_bound() {
    let now = SystemTime::UNIX_EPOCH + Duration::from_secs(784_111_777);
    let max = Duration::from_secs(10);
    assert_eq!(
        retry_after_delay("3", now, max),
        Some(Duration::from_secs(3))
    );
    assert_eq!(retry_after_delay("3600", now, max), Some(max));
    assert_eq!(retry_after_delay("0", now, max), Some(Duration::ZERO));
    assert_eq!(retry_after_delay("", now, max), None);
    assert_eq!(retry_after_delay("soon", now, max), None);
    assert_eq!(
        retry_after_delay("Sun, 06 Nov 1994 08:49:42 GMT", now, max),
        Some(Duration::from_secs(5))
    );
    assert_eq!(
        retry_after_delay("Sun, 06 Nov 1994 08:49:00 GMT", now, max),
        Some(Duration::ZERO)
    );
    assert_eq!(
        retry_after_delay("Sun, 06 Nov 1994 09:49:37 GMT", now, max),
        Some(max)
    );
}

#[test]
fn model_unavailable_only_for_retryable_statuses() {
    assert!(model_unavailable(503, "No available model provider meets"));
    assert!(model_unavailable(429, "model_not_available"));
    assert!(!model_unavailable(404, "No endpoints found for x"));
    assert!(!model_unavailable(503, "upstream hiccup"));
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
