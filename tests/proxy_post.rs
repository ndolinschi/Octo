use std::sync::{Arc, Mutex};

use axum::{
    body::{to_bytes, Body},
    extract::State,
    http::{header, HeaderMap, Request, StatusCode},
    response::IntoResponse,
    routing::post,
    Router,
};
use octo::config::Config;
use octo::providers::utils::{forward_content_type, proxy_post};
use octo::proxy::error::ProxyError;
use octo::routes;
use octo::state::AppState;
use reqwest::Client;
use tower::ServiceExt;

#[derive(Clone, Default)]
struct UpstreamCapture(Arc<Mutex<Option<String>>>);

async fn mock_upstream(
    State(capture): State<UpstreamCapture>,
    headers: HeaderMap,
    body: Body,
) -> impl IntoResponse {
    let auth = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    *capture.0.lock().unwrap() = auth;
    let body = to_bytes(body, usize::MAX)
        .await
        .unwrap_or_default();
    (StatusCode::OK, [(header::CONTENT_TYPE, "application/json")], body)
}

async fn spawn_mock_upstream() -> (String, UpstreamCapture) {
    let capture = UpstreamCapture::default();
    let app = Router::new()
        .route("/echo", post(mock_upstream))
        .with_state(capture.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    (format!("http://{addr}/echo"), capture)
}

fn sample_config(max_body_bytes: usize) -> Config {
    Config {
        bind_addr: "127.0.0.1:8080".to_string(),
        allow_remote: false,
        upstream_connect_timeout_secs: 30,
        upstream_request_timeout_secs: 600,
        openrouter_chat_completions_url: "https://example.com/chat".to_string(),
        openrouter_chat_completions_path: "/v1/chat/completions".to_string(),
        openrouter_decisions_url: "https://example.com/decisions".to_string(),
        openrouter_decisions_path: "/v1/decisions".to_string(),
        openrouter_http_referer: None,
        openrouter_title: None,
        anthropic_messages_url: "https://example.com/messages".to_string(),
        anthropic_api_version: "2023-06-01".to_string(),
        anthropic_messages_path: "/v1/messages".to_string(),
        max_body_bytes,
        llm_chat_backend: "openrouter".to_string(),
        llm_messages_backend: "anthropic".to_string(),
        decision_backend: "openrouter".to_string(),
    }
}

#[tokio::test]
async fn proxy_post_forwards_auth_and_streams_response() {
    let (url, capture) = spawn_mock_upstream().await;
    let client = Client::builder().build().unwrap();
    let request = Request::builder()
        .method("POST")
        .uri("http://127.0.0.1:8080/v1/chat/completions")
        .header(header::AUTHORIZATION, "Bearer test-token")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(r#"{"ok":true}"#))
        .unwrap();

    let response = proxy_post(
        &client,
        &url,
        4096,
        request,
        |mut upstream, parts| {
            if let Some(value) = parts.headers.get(header::AUTHORIZATION) {
                upstream = upstream.header(header::AUTHORIZATION, value);
            }
            forward_content_type(upstream, parts)
        },
    )
    .await
    .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        capture.0.lock().unwrap().as_deref(),
        Some("Bearer test-token")
    );
    let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    assert_eq!(body.as_ref(), br#"{"ok":true}"#);
}

#[tokio::test]
async fn proxy_post_maps_oversized_body_to_413() {
    let client = Client::builder().build().unwrap();
    let request = Request::builder()
        .method("POST")
        .uri("http://127.0.0.1:8080/v1/chat/completions")
        .body(Body::from(vec![0_u8; 256]))
        .unwrap();

    let err = proxy_post(
        &client,
        "http://127.0.0.1:9/unused",
        64,
        request,
        |upstream, parts| forward_content_type(upstream, parts),
    )
    .await
    .unwrap_err();

    assert!(matches!(err, ProxyError::BodyTooLarge));
    let response = err.into_response();
    assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
}

#[tokio::test]
async fn proxy_post_maps_upstream_failure_to_502() {
    let client = Client::builder()
        .connect_timeout(std::time::Duration::from_secs(2))
        .build()
        .unwrap();
    let request = Request::builder()
        .method("POST")
        .uri("http://127.0.0.1:8080/v1/chat/completions")
        .body(Body::from("{}"))
        .unwrap();

    let err = proxy_post(
        &client,
        "http://127.0.0.1:1/refused",
        4096,
        request,
        |upstream, parts| forward_content_type(upstream, parts),
    )
    .await
    .unwrap_err();

    assert!(matches!(err, ProxyError::Upstream(_)));
    let response = err.into_response();
    assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
}

#[tokio::test]
async fn chat_route_returns_413_when_body_exceeds_limit() {
    let config = sample_config(32);
    let state = AppState::new(config).unwrap();
    let app = routes::router(state);
    let request = Request::builder()
        .method("POST")
        .uri("/v1/chat/completions")
        .header(header::AUTHORIZATION, "Bearer x")
        .body(Body::from(vec![0_u8; 64]))
        .unwrap();

    let response = app.oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
}

#[test]
fn non_loopback_bind_requires_allow_remote() {
    let mut config = sample_config(1024);
    config.bind_addr = "0.0.0.0:8080".to_string();
    assert!(config.ensure_bind_allowed().is_err());
    config.allow_remote = true;
    assert!(config.ensure_bind_allowed().is_ok());
}
