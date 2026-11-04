mod support;

use std::time::{Duration, Instant};

use axum::{
    body::Body,
    http::{header, Request, StatusCode},
    routing::post,
    Router,
};
use futures_util::StreamExt;
use octo::history::{CallKind, CallObserve, CallProvider, History};
use octo::providers::utils::{forward_content_type, proxy_post};
use reqwest::Client;
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
            kind: CallKind::Llm,
            provider: CallProvider::OpenAi,
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

    let hash = history.token_hash("sk-secret").unwrap();
    let row = poll_call(&history, || {
        sqlx::query!(
            "SELECT provider, model, message, input, output, token_hash, status, request_bytes, response_bytes FROM calls"
        )
        .fetch_optional(history.pool().unwrap())
    })
    .await;
    assert_eq!(row.provider, "openai");
    assert_eq!(row.model.as_deref(), Some("gpt-test"));
    assert_eq!(row.message.as_deref(), Some("hello"));
    assert_eq!(row.input, input);
    assert_eq!(row.output, "onetwo");
    assert_eq!(row.token_hash.as_deref(), Some(hash.as_str()));
    assert!(!hash.contains("sk-secret"));
    assert_eq!(row.status, 200);
    assert_eq!(row.request_bytes, input.len() as i64);
    assert_eq!(row.response_bytes, 6);
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
            kind: CallKind::Decision,
            provider: CallProvider::OpenRouter,
        }),
    )
    .await
    .unwrap();
    let mut body = response.into_body().into_data_stream();
    while body.next().await.is_some() {}

    let token_hash = poll_call(&history, || {
        sqlx::query_scalar!("SELECT token_hash FROM calls").fetch_optional(history.pool().unwrap())
    })
    .await;
    assert_eq!(token_hash, None);
}

#[tokio::test]
async fn decisions_response_is_stored_with_its_kind() {
    let (url, _) = support::spawn_header_capture_server("/echo", "authorization").await;
    let history = History::connect("sqlite::memory:", "test-token-key", 1024)
        .await
        .unwrap();
    let client = Client::builder().build().unwrap();
    let request = Request::builder()
        .method("POST")
        .uri("http://127.0.0.1:8080/v1/decisions")
        .header(header::AUTHORIZATION, "Bearer sk-decision")
        .body(Body::from(r#"{"model":"router","input":"pick"}"#))
        .unwrap();
    let response = proxy_post(
        &client,
        &format!("http://{url}/echo"),
        4096,
        request,
        forward_content_type,
        Some(CallObserve {
            history: history.clone(),
            kind: CallKind::Decision,
            provider: CallProvider::OpenRouter,
        }),
    )
    .await
    .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let mut body = response.into_body().into_data_stream();
    while body.next().await.is_some() {}

    let row = poll_call(&history, || {
        sqlx::query!("SELECT kind, provider, message, output, status FROM calls")
            .fetch_optional(history.pool().unwrap())
    })
    .await;
    assert_eq!(row.kind, "decision");
    assert_eq!(row.provider, "openrouter");
    assert_eq!(row.message.as_deref(), Some("pick"));
    assert_eq!(row.status, 200);
}

#[tokio::test]
async fn usage_past_the_stored_prefix_is_kept() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let payload = format!(
        "{}{}",
        "X".repeat(70_000),
        "\n{\"usage\":{\"prompt_tokens\":8,\"completion_tokens\":9,\"cost\":1.5}}"
    );
    let payload_task = payload.clone();
    tokio::spawn(async move {
        let app = Router::new().route(
            "/echo",
            post(move || {
                let payload_task = payload_task.clone();
                async move { payload_task }
            }),
        );
        axum::serve(listener, app).await.unwrap();
    });
    let history = History::connect("sqlite::memory:", "test-token-key", 4)
        .await
        .unwrap();
    let client = Client::builder().build().unwrap();
    let request = Request::builder()
        .method("POST")
        .uri("http://127.0.0.1:8080/v1/chat/completions")
        .header(header::AUTHORIZATION, "Bearer sk-secret")
        .body(Body::from("{}"))
        .unwrap();
    let response = proxy_post(
        &client,
        &format!("http://{addr}/echo"),
        4096,
        request,
        forward_content_type,
        Some(CallObserve {
            history: history.clone(),
            kind: CallKind::Llm,
            provider: CallProvider::OpenAi,
        }),
    )
    .await
    .unwrap();
    let mut body = response.into_body().into_data_stream();
    let mut got = Vec::new();
    while let Some(chunk) = body.next().await {
        got.extend_from_slice(&chunk.unwrap());
    }
    drop(body);
    assert_eq!(got, payload.as_bytes());
    let row = poll_call(&history, || {
        sqlx::query!(
            "SELECT output, input_tokens, output_tokens, cost_micros, response_bytes FROM calls"
        )
        .fetch_optional(history.pool().unwrap())
    })
    .await;
    assert_eq!(row.output, "XXXX");
    assert_eq!(row.input_tokens, Some(8));
    assert_eq!(row.output_tokens, Some(9));
    assert_eq!(row.cost_micros, Some(1_500_000));
    assert_eq!(row.response_bytes, payload.len() as i64);
}

#[tokio::test]
async fn upstream_chunk_error_is_stored_as_failure() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let mut socket = listener.accept().await.unwrap().0;
        let mut buf = Vec::new();
        let mut tmp = [0_u8; 1024];
        loop {
            let n = socket.read(&mut tmp).await.unwrap();
            if n == 0 {
                break;
            }
            buf.extend_from_slice(&tmp[..n]);
            if buf.windows(4).any(|w| w == b"\r\n\r\n") {
                break;
            }
        }
        socket
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 11\r\nConnection: close\r\n\r\npartial")
            .await
            .unwrap();
    });
    let history = History::connect("sqlite::memory:", "test-token-key", 1024)
        .await
        .unwrap();
    let client = Client::builder().build().unwrap();
    let request = Request::builder()
        .method("POST")
        .uri("http://127.0.0.1:8080/v1/chat/completions")
        .body(Body::from("{}"))
        .unwrap();
    let response = proxy_post(
        &client,
        &format!("http://{addr}/echo"),
        4096,
        request,
        forward_content_type,
        Some(CallObserve {
            history: history.clone(),
            kind: CallKind::Llm,
            provider: CallProvider::OpenAi,
        }),
    )
    .await
    .unwrap();
    let mut body = response.into_body().into_data_stream();
    while body.next().await.is_some() {}
    drop(body);
    let row = poll_call(&history, || {
        sqlx::query!("SELECT status, output FROM calls").fetch_optional(history.pool().unwrap())
    })
    .await;
    assert_eq!(row.status, 502);
    assert_eq!(row.output, "partial");
}

async fn poll_call<T, F, Fut>(_: &History, mut load: F) -> T
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<Option<T>, sqlx::Error>>,
{
    for _ in 0..50 {
        if let Some(row) = load().await.unwrap() {
            return row;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("history row");
}
