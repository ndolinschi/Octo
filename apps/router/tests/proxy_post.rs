mod support;

use std::sync::{Arc, Mutex};

use axum::{
    body::{to_bytes, Body},
    extract::State,
    http::{header, HeaderMap, Request, StatusCode},
    response::IntoResponse,
    routing::post,
    Router,
};
use octo::providers::utils::{forward_content_type, proxy_post};
use octo::proxy::error::ProxyError;
use octo::routes;
use octo::state::AppState;
use reqwest::Client;
use support::sample_config;
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
    let body = to_bytes(body, usize::MAX).await.unwrap_or_default();
    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, "application/json")],
        body,
    )
}

async fn spawn_mock_upstream() -> (String, UpstreamCapture) {
    let capture = UpstreamCapture::default();
    let app = Router::new()
        .route("/echo", post(mock_upstream))
        .with_state(capture.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
    tokio::spawn(async move {
        let _ = ready_tx.send(());
        axum::serve(listener, app).await.unwrap();
    });
    ready_rx.await.unwrap();
    (format!("http://{addr}/echo"), capture)
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
        None,
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
        forward_content_type,
        None,
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
        forward_content_type,
        None,
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
    config.client_auth_key = "secret".to_string();
    assert!(config.ensure_bind_allowed().is_ok());
}

#[test]
fn non_loopback_bind_requires_client_auth_key() {
    let mut config = sample_config(1024);
    config.bind_addr = "0.0.0.0:8080".to_string();
    config.allow_remote = true;
    config.client_auth_key = String::new();
    assert!(config.ensure_bind_allowed().is_err());
    config.client_auth_key = "proxy-key".to_string();
    assert!(config.ensure_bind_allowed().is_ok());
    config.bind_addr = "127.0.0.1:8080".to_string();
    config.client_auth_key = String::new();
    assert!(config.ensure_bind_allowed().is_ok());
}

#[tokio::test]
async fn client_auth_key_rejects_missing_header() {
    let mut config = sample_config(1024);
    config.client_auth_key = "proxy-key".to_string();
    let state = AppState::new(config).unwrap();
    let app = routes::router(state);
    let request = Request::builder()
        .method("GET")
        .uri("/autoroute/status")
        .body(Body::empty())
        .unwrap();
    let response = app.oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn client_auth_key_allows_matching_header_and_health() {
    let mut config = sample_config(1024);
    config.client_auth_key = "proxy-key".to_string();
    let state = AppState::new(config).unwrap();
    let app = routes::router(state.clone());
    let health = Request::builder()
        .method("GET")
        .uri("/health")
        .body(Body::empty())
        .unwrap();
    let response = app.clone().oneshot(health).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let status = Request::builder()
        .method("GET")
        .uri("/autoroute/status")
        .header("x-octo-key", "proxy-key")
        .body(Body::empty())
        .unwrap();
    let response = app.oneshot(status).await.unwrap();
    assert_ne!(response.status(), StatusCode::UNAUTHORIZED);
}
