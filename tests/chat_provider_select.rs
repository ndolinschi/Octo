mod support;

use axum::{
    body::Body,
    http::{header, Request, StatusCode},
};
use octo::routes;
use octo::state::AppState;
use support::{sample_config, spawn_uri_capture_server};
use tower::ServiceExt;

#[tokio::test]
async fn chat_route_body_type_openrouter_selects_openrouter_upstream() {
    let (addr, captured) = spawn_uri_capture_server("/upstream").await;
    let mut config = sample_config(4096);
    config.openai_chat_completions_url = format!("http://{addr}/openai-upstream");
    config.openrouter_chat_completions_url = format!("http://{addr}/upstream");
    let state = AppState::new(config).unwrap();
    let app = routes::router(state);
    let request = Request::builder()
        .method("POST")
        .uri("/v1/chat/completions")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(
            r#"{"type":"OPENROUTER","model":"x","messages":[]}"#,
        ))
        .unwrap();

    let response = app.oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        captured.lock().unwrap().as_deref(),
        Some("/upstream")
    );
}

#[tokio::test]
async fn chat_path_alias_openrouter_without_body_type() {
    let (addr, captured) = spawn_uri_capture_server("/upstream").await;
    let mut config = sample_config(4096);
    config.openai_chat_completions_url = format!("http://{addr}/openai-upstream");
    config.openrouter_chat_completions_url = format!("http://{addr}/upstream");
    let state = AppState::new(config).unwrap();
    let app = routes::router(state);
    let request = Request::builder()
        .method("POST")
        .uri("/openrouter/completions")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(r#"{"model":"x","messages":[]}"#))
        .unwrap();

    let response = app.oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        captured.lock().unwrap().as_deref(),
        Some("/upstream")
    );
}

#[tokio::test]
async fn chat_path_alias_openai_hits_openai_upstream() {
    let (addr, captured) = spawn_uri_capture_server("/openai-upstream").await;
    let mut config = sample_config(4096);
    config.openai_chat_completions_url = format!("http://{addr}/openai-upstream");
    config.openrouter_chat_completions_url = format!("http://{addr}/upstream");
    let state = AppState::new(config).unwrap();
    let app = routes::router(state);
    let request = Request::builder()
        .method("POST")
        .uri("/openai/completions")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(r#"{"model":"gpt-4o-mini","messages":[]}"#))
        .unwrap();

    let response = app.oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        captured.lock().unwrap().as_deref(),
        Some("/openai-upstream")
    );
}

#[test]
fn unknown_llm_chat_backend_rejected_at_startup() {
    let mut config = sample_config(1024);
    config.llm_chat_backend = "direct-openai".to_string();
    assert!(AppState::new(config).is_err());
}

#[tokio::test]
async fn invalid_chat_type_returns_400() {
    let config = sample_config(4096);
    let state = AppState::new(config).unwrap();
    let app = routes::router(state);
    let request = Request::builder()
        .method("POST")
        .uri("/v1/chat/completions")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(r#"{"type":"bogus","model":"x"}"#))
        .unwrap();
    let response = app.oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn malformed_chat_json_returns_400() {
    let config = sample_config(4096);
    let state = AppState::new(config).unwrap();
    let app = routes::router(state);
    let request = Request::builder()
        .method("POST")
        .uri("/v1/chat/completions")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(r#"{"type":"OPENROUTER","model":"x""#))
        .unwrap();
    let response = app.oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn invalid_type_falls_back_to_octo_provider() {
    let (addr, captured) = spawn_uri_capture_server("/upstream").await;
    let mut config = sample_config(4096);
    config.openai_chat_completions_url = format!("http://{addr}/openai-upstream");
    config.openrouter_chat_completions_url = format!("http://{addr}/upstream");
    let state = AppState::new(config).unwrap();
    let app = routes::router(state);
    let request = Request::builder()
        .method("POST")
        .uri("/v1/chat/completions")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(
            r#"{"type":"bogus","octo_provider":"OPENROUTER","model":"x"}"#,
        ))
        .unwrap();
    let response = app.oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        captured.lock().unwrap().as_deref(),
        Some("/upstream")
    );
}
