mod support;

use axum::{
    body::Body,
    http::{header, Request, StatusCode},
};
use octo::routes;
use octo::state::AppState;
use support::{sample_config, spawn_header_capture_server};
use tower::ServiceExt;

#[tokio::test]
async fn openai_organization_header_is_forwarded() {
    let (addr, captured) = spawn_header_capture_server("/upstream", "openai-organization").await;
    let mut config = sample_config(4096);
    config.openai_chat_completions_url = format!("http://{addr}/upstream");
    let state = AppState::new(config).unwrap();
    let app = routes::router(state);
    let request = Request::builder()
        .method("POST")
        .uri("/openai/completions")
        .header(header::AUTHORIZATION, "Bearer test-token")
        .header(header::CONTENT_TYPE, "application/json")
        .header("OpenAI-Organization", "org-test")
        .body(Body::from(r#"{"model":"gpt-4o-mini","messages":[]}"#))
        .unwrap();

    let response = app.oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        captured.lock().unwrap().as_deref(),
        Some("org-test")
    );
}
