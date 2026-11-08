mod support;

use axum::{
    body::Body,
    http::{header, Request, StatusCode},
};
use octo::routes;
use octo::state::AppState;
use support::{sample_config, spawn_header_capture_server, spawn_uri_capture_server};
use tower::ServiceExt;

#[tokio::test]
async fn openrouter_messages_route_forwards_authorization() {
    let (addr, captured) = spawn_header_capture_server("/messages", "authorization").await;
    let mut config = sample_config(4096);
    config.openrouter_messages_url = format!("http://{addr}/messages");
    config.llm_messages_backend = "openrouter".to_string();
    let state = AppState::new(config).unwrap();
    let app = routes::router(state);
    let request = Request::builder()
        .method("POST")
        .uri("/openrouter/v1/messages")
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::AUTHORIZATION, "Bearer openrouter-key")
        .body(Body::from(
            r#"{"model":"anthropic/claude-sonnet-4","max_tokens":1,"messages":[]}"#,
        ))
        .unwrap();
    let response = app.oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        captured.lock().unwrap().as_deref(),
        Some("Bearer openrouter-key")
    );
}

#[tokio::test]
async fn messages_route_forwards_bearer_as_openrouter_auth() {
    let (addr, captured) = spawn_header_capture_server("/messages", "authorization").await;
    let mut config = sample_config(4096);
    config.openrouter_messages_url = format!("http://{addr}/messages");
    config.llm_messages_backend = "openrouter".to_string();
    let state = AppState::new(config).unwrap();
    let app = routes::router(state);
    let request = Request::builder()
        .method("POST")
        .uri("/v1/messages")
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::AUTHORIZATION, "Bearer openrouter-key")
        .body(Body::from(
            r#"{"model":"google/gemma-4-26b-a4b-it","max_tokens":1,"messages":[]}"#,
        ))
        .unwrap();
    let response = app.oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        captured.lock().unwrap().as_deref(),
        Some("Bearer openrouter-key")
    );
}

#[tokio::test]
async fn claude_messages_route_maps_bearer_to_x_api_key() {
    let (addr, captured) = spawn_header_capture_server("/messages", "x-api-key").await;
    let mut config = sample_config(4096);
    config.anthropic_messages_url = format!("http://{addr}/messages");
    config.llm_messages_backend = "claude".to_string();
    let state = AppState::new(config).unwrap();
    let app = routes::router(state);
    let request = Request::builder()
        .method("POST")
        .uri("/v1/messages")
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::AUTHORIZATION, "Bearer anthropic-key")
        .body(Body::from(
            r#"{"model":"claude-3-5-haiku-20241022","max_tokens":1,"messages":[]}"#,
        ))
        .unwrap();
    let response = app.oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(captured.lock().unwrap().as_deref(), Some("anthropic-key"));
}

#[tokio::test]
async fn messages_route_forwards_x_api_key() {
    let (addr, captured) = spawn_header_capture_server("/messages", "x-api-key").await;
    let mut config = sample_config(4096);
    config.anthropic_messages_url = format!("http://{addr}/messages");
    let state = AppState::new(config).unwrap();
    let app = routes::router(state);
    let request = Request::builder()
        .method("POST")
        .uri("/v1/messages")
        .header(header::CONTENT_TYPE, "application/json")
        .header("x-api-key", "secret-key")
        .body(Body::from(
            r#"{"model":"claude","max_tokens":1,"messages":[]}"#,
        ))
        .unwrap();
    let response = app.oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(captured.lock().unwrap().as_deref(), Some("secret-key"));
}

#[tokio::test]
async fn decisions_route_hits_configured_upstream_path() {
    let (addr, captured) = spawn_uri_capture_server("/decisions").await;
    let mut config = sample_config(4096);
    config.openrouter_decisions_url = format!("http://{addr}/decisions");
    let state = AppState::new(config).unwrap();
    let app = routes::router(state);
    let request = Request::builder()
        .method("POST")
        .uri("/v1/decisions")
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::AUTHORIZATION, "Bearer test")
        .body(Body::from(
            r#"{"model":"typesafe/jev-1.13","state":{},"questions":{}}"#,
        ))
        .unwrap();
    let response = app.oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(captured.lock().unwrap().as_deref(), Some("/decisions"));
}

#[tokio::test]
async fn health_route_returns_ok() {
    let config = sample_config(1024);
    let state = AppState::new(config).unwrap();
    let app = routes::router(state);
    let request = Request::builder()
        .uri("/health")
        .body(Body::empty())
        .unwrap();
    let response = app.oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
}

#[tokio::test]
async fn autoroute_status_returns_seeded_session() {
    use http_body_util::BodyExt;
    use octo::auto::SessionChoice;
    use serde_json::Value;

    let config = sample_config(1024);
    let state = AppState::new(config).unwrap();
    state.auto.seed_session(
        "status-sess",
        SessionChoice::fresh("mid-m".into(), vec!["Read".into()], "mid".into()),
    );
    state.auto.add_session_cost("status-sess", 250_000);
    let app = routes::router(state);
    let request = Request::builder()
        .uri("/autoroute/status?session=status-sess")
        .body(Body::empty())
        .unwrap();
    let response = app.oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let body: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(body["session_id"], "status-sess");
    assert_eq!(body["tier"], "mid");
    assert_eq!(body["model"], "mid-m");
    assert!((body["cost_usd"].as_f64().unwrap() - 0.25).abs() < 1e-9);
    assert_eq!(body["history_dropped_inserts"], 0);
}

#[tokio::test]
async fn autoroute_status_unknown_session_is_404() {
    use http_body_util::BodyExt;
    use serde_json::Value;

    let config = sample_config(1024);
    let state = AppState::new(config).unwrap();
    let app = routes::router(state);
    let request = Request::builder()
        .uri("/autoroute/status?session=missing")
        .body(Body::empty())
        .unwrap();
    let response = app.oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let body: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(body["error"], "unknown session");
}
