mod support;

use std::time::{Duration, Instant};

use axum::{
    body::Body,
    http::{header, Request, StatusCode},
    routing::post,
    Router,
};
use futures_util::StreamExt;
use octo::history::{CallObserve, History};
use octo::providers::utils::{forward_content_type, proxy_post};
use reqwest::Client;
use sqlx::Row;
use tokio::net::TcpListener;

#[tokio::test]
async fn streamed_response_is_forwarded_then_stored() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let app = Router::new().route(
            "/echo",
            post(|| async {
                let stream = futures_util::stream::unfold(0, |step| async move {
                    if step > 1 {
                        return None;
                    }
                    tokio::time::sleep(Duration::from_millis(40)).await;
                    let chunk = if step == 0 { "one" } else { "two" };
                    Some((
                        Ok::<_, std::io::Error>(axum::body::Bytes::from(chunk)),
                        step + 1,
                    ))
                });
                Body::from_stream(stream)
            }),
        );
        axum::serve(listener, app).await.unwrap();
    });

    let history = History::connect("sqlite::memory:", "test-token-key", 1024)
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
        &format!("http://{addr}/echo"),
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
    let mut body = response.into_body().into_data_stream();
    let started = Instant::now();
    let first = body.next().await.unwrap().unwrap();
    let first_at = started.elapsed();
    let second = body.next().await.unwrap().unwrap();
    let second_at = started.elapsed();
    assert_eq!(first.as_ref(), b"one");
    assert_eq!(second.as_ref(), b"two");
    assert!(second_at > first_at);
    assert!(second_at - first_at >= Duration::from_millis(20));
    assert!(body.next().await.is_none());
    drop(body);

    let hash = history.token_hash("sk-secret");
    let mut stored = None;
    for _ in 0..50 {
        let row = sqlx::query(
            "SELECT provider, model, message, input, output, token_hash, status, request_bytes, response_bytes FROM calls",
        )
        .fetch_optional(history.pool().unwrap())
        .await
        .unwrap();
        if let Some(row) = row {
            stored = Some(row);
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let row = stored.expect("history row");
    let provider: String = row.get("provider");
    let model: String = row.get("model");
    let message: String = row.get("message");
    let stored_input: String = row.get("input");
    let output: String = row.get("output");
    let token_hash: String = row.get("token_hash");
    let status: i64 = row.get("status");
    let request_bytes: i64 = row.get("request_bytes");
    let response_bytes: i64 = row.get("response_bytes");
    assert_eq!(provider, "openai");
    assert_eq!(model, "gpt-test");
    assert_eq!(message, "hello");
    assert_eq!(stored_input, input);
    assert_eq!(output, "onetwo");
    assert_eq!(token_hash, hash);
    assert!(!token_hash.contains("sk-secret"));
    assert_eq!(status, 200);
    assert_eq!(request_bytes, input.len() as i64);
    assert_eq!(response_bytes, 6);
}

#[tokio::test]
async fn missing_token_is_not_a_shared_identity() {
    let history = History::connect("sqlite::memory:", "test-token-key", 1024)
        .await
        .unwrap();
    let (url, _) = support::spawn_header_capture_server("/echo", "authorization").await;
    let client = Client::builder().build().unwrap();
    let request = Request::builder()
        .method("POST")
        .uri("http://127.0.0.1:8080/v1/chat/completions")
        .body(Body::from("{}"))
        .unwrap();
    let response = proxy_post(
        &client,
        &format!("http://{url}/echo"),
        4096,
        request,
        forward_content_type,
        Some(CallObserve {
            history: history.clone(),
            kind: "decision",
            provider: "openrouter",
        }),
    )
    .await
    .unwrap();
    let mut body = response.into_body().into_data_stream();
    while body.next().await.is_some() {}

    let mut token_hash = Some("pending".to_string());
    for _ in 0..50 {
        let row = sqlx::query("SELECT token_hash FROM calls")
            .fetch_optional(history.pool().unwrap())
            .await
            .unwrap();
        if let Some(row) = row {
            token_hash = row.get("token_hash");
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(token_hash, None);
}
