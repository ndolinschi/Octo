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
