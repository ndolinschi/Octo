mod support;

use axum::{
    body::{to_bytes, Body},
    http::{header, Request, StatusCode},
};
use octo::history::{CallObserve, History};
use octo::providers::utils::{forward_content_type, proxy_post};
use reqwest::Client;
use sqlx::Row;

#[tokio::test]
async fn streamed_response_is_unchanged_and_stored() {
    let (url, _) = support::spawn_header_capture_server("/echo", "authorization").await;
    let history = History::connect("sqlite::memory:", "test-token-key")
        .await
        .unwrap();
    let client = Client::builder().build().unwrap();
    let input = r#"{"model":"gpt-test","messages":[{"role":"user","content":"hello"}]}"#;
    let request = Request::builder()
        .method("POST")
        .uri("http://127.0.0.1:8080/v1/chat/completions")
        .header(header::AUTHORIZATION, "Bearer sk-secret")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(input))
        .unwrap();

    let response = proxy_post(
        &client,
        &format!("http://{url}/echo"),
        4096,
        request,
        |mut upstream, parts| {
            if let Some(value) = parts.headers.get(header::AUTHORIZATION) {
                upstream = upstream.header(header::AUTHORIZATION, value);
            }
            forward_content_type(upstream, parts)
        },
        Some(CallObserve {
            history: history.clone(),
            kind: "llm",
            provider: "openai",
        }),
    )
    .await
    .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    assert!(body.is_empty());

    let hash = history.token_hash("sk-secret");
    let mut stored = None;
    for _ in 0..50 {
        let row = sqlx::query(
            "SELECT provider, model, message, input, output, token_hash, status, request_bytes FROM calls",
        )
        .fetch_optional(history_pool(&history).await)
        .await
        .unwrap();
        if let Some(row) = row {
            stored = Some(row);
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    let row = stored.expect("history row");
    let provider: String = row.get("provider");
    let model: String = row.get("model");
    let message: String = row.get("message");
    let stored_input: String = row.get("input");
    let token_hash: String = row.get("token_hash");
    let status: i64 = row.get("status");
    let request_bytes: i64 = row.get("request_bytes");
    assert_eq!(provider, "openai");
    assert_eq!(model, "gpt-test");
    assert_eq!(message, "hello");
    assert_eq!(stored_input, input);
    assert_eq!(token_hash, hash);
    assert!(!token_hash.contains("sk-secret"));
    assert_eq!(status, 200);
    assert_eq!(request_bytes, input.len() as i64);
}

async fn history_pool(history: &History) -> &sqlx::SqlitePool {
    history.pool().expect("pool")
}
