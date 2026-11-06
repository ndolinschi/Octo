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
            rerouting: 0,
            rerouting_reason: None,
            session_id: None,
            tier_before: None,
            tier_after: None,
            trigger: "none".to_string(),
            trimmed_from_tokens: None,
            client_model: None,
            client_has_thinking: None,
            client_tool_names: None,
            bg_signal: None,
            hk_text_signal: None,
            auto: None,
            on_response: None,
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
            rerouting: 0,
            rerouting_reason: None,
            session_id: None,
            tier_before: None,
            tier_after: None,
            trigger: "none".to_string(),
            trimmed_from_tokens: None,
            client_model: None,
            client_has_thinking: None,
            client_tool_names: None,
            bg_signal: None,
            hk_text_signal: None,
            auto: None,
            on_response: None,
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
            rerouting: 0,
            rerouting_reason: None,
            session_id: None,
            tier_before: None,
            tier_after: None,
            trigger: "none".to_string(),
            trimmed_from_tokens: None,
            client_model: None,
            client_has_thinking: None,
            client_tool_names: None,
            bg_signal: None,
            hk_text_signal: None,
            auto: None,
            on_response: None,
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
            rerouting: 0,
            rerouting_reason: None,
            session_id: None,
            tier_before: None,
            tier_after: None,
            trigger: "none".to_string(),
            trimmed_from_tokens: None,
            client_model: None,
            client_has_thinking: None,
            client_tool_names: None,
            bg_signal: None,
            hk_text_signal: None,
            auto: None,
            on_response: None,
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
            rerouting: 0,
            rerouting_reason: None,
            session_id: None,
            tier_before: None,
            tier_after: None,
            trigger: "none".to_string(),
            trimmed_from_tokens: None,
            client_model: None,
            client_has_thinking: None,
            client_tool_names: None,
            bg_signal: None,
            hk_text_signal: None,
            auto: None,
            on_response: None,
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

#[tokio::test]
async fn decision_row_is_inserted_into_decisions() {
    use octo::history::DecisionRow;

    let history = History::connect("sqlite::memory:", "test-token-key", 1024)
        .await
        .unwrap();
    history.record_decision(DecisionRow {
        session_id: Some("sess-1".to_string()),
        purpose: "classify".to_string(),
        model: "typesafe/jev-1.13".to_string(),
        status: 200,
        latency_ms: 12,
        user_text: "hello".to_string(),
        is_hard: Some(false),
        is_easy: Some(true),
        is_hard_score: Some(0.12),
        is_easy_score: Some(0.88),
        tools_enough: Some("true".to_string()),
        complexity: Some("low"),
        choice_rule: "is_easy".to_string(),
        missing_tools: Some(String::new()),
        request_payload: "{}".to_string(),
        response_payload: "{}".to_string(),
        cost: None,
        or_cost: None,
        upstream_cost: None,
        estimated_cost: None,
        cost_source: "none".into(),
    });
    history.drain().await;
    let row = poll_call(&history, || async {
        let row = sqlx::query(
            "SELECT session_id, purpose, complexity, choice_rule, user_text, is_hard_score, is_easy_score FROM decisions",
        )
        .fetch_optional(history.pool().unwrap())
        .await?;
        Ok(row.map(|row| {
            use sqlx::Row;
            (
                row.get::<Option<String>, _>("session_id"),
                row.get::<String, _>("purpose"),
                row.get::<Option<String>, _>("complexity"),
                row.get::<String, _>("choice_rule"),
                row.get::<String, _>("user_text"),
                row.get::<Option<f64>, _>("is_hard_score"),
                row.get::<Option<f64>, _>("is_easy_score"),
            )
        }))
    })
    .await;
    assert_eq!(row.0.as_deref(), Some("sess-1"));
    assert_eq!(row.1, "classify");
    assert_eq!(row.2.as_deref(), Some("low"));
    assert_eq!(row.5, Some(0.12));
    assert_eq!(row.6, Some(0.88));
    assert_eq!(row.3, "is_easy");
    assert_eq!(row.4, "hello");
}

#[tokio::test]
async fn store_payloads_false_omits_text_keeps_costs() {
    use octo::history::{CostMicros, FinishedCall, Millis};

    let history = History::connect("sqlite::memory:", "test-token-key", 1024)
        .await
        .unwrap()
        .with_store_payloads(false);
    let tool_body = serde_json::json!({
        "messages": [{
            "role": "user",
            "content": [{
                "type": "tool_result",
                "tool_use_id": "t1",
                "content": "test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out"
            }]
        }]
    })
    .to_string();
    history.record(FinishedCall {
        kind: CallKind::Messages,
        provider: CallProvider::OpenRouter,
        model: Some("m".into()),
        token_hash: None,
        message: Some("secret".into()),
        input: tool_body,
        output: "out".into(),
        request_payload: "{\"secret\":true}".into(),
        response_payload: "{\"secret\":false}".into(),
        status: 200,
        latency_ms: Millis::new(1),
        request_bytes: 10,
        response_bytes: 3,
        input_tokens: None,
        output_tokens: None,
        cost: Some(CostMicros(42)),
        or_cost: None,
        upstream_cost: None,
        estimated_cost: None,
        cost_source: "upstream".into(),
        is_byok: Some(true),
        upstream_provider: Some("Mistral".into()),
        trimmed_from_tokens: None,
        client_model: Some("claude-haiku".into()),
        client_has_thinking: Some(false),
        client_tool_names: Some("Bash".into()),
        bg_signal: Some(true),
        hk_text_signal: Some(false),
        cache_read_tokens: None,
        cache_write_tokens: None,
        generation_id: None,
        rerouting: 0,
        rerouting_reason: None,
        session_id: Some("payload-off".into()),
        tier_before: Some("low".into()),
        tier_after: Some("low".into()),
        trigger: "classify".into(),
    });
    history.drain().await;
    let row = poll_call(&history, || async {
        let row = sqlx::query(
            "SELECT message, input, output, request_payload, response_payload, cost_micros, cost_source, client_model, bg_signal FROM calls",
        )
        .fetch_optional(history.pool().unwrap())
        .await?;
        Ok(row.map(|row| {
            use sqlx::Row;
            (
                row.get::<Option<String>, _>("message"),
                row.get::<String, _>("input"),
                row.get::<String, _>("output"),
                row.get::<Option<String>, _>("request_payload"),
                row.get::<Option<String>, _>("response_payload"),
                row.get::<Option<i64>, _>("cost_micros"),
                row.get::<Option<String>, _>("cost_source"),
                row.get::<Option<String>, _>("client_model"),
                row.get::<Option<i64>, _>("bg_signal"),
            )
        }))
    })
    .await;
    assert!(row.0.is_none());
    assert_eq!(row.1, "");
    assert_eq!(row.2, "");
    assert!(row.3.is_none());
    assert!(row.4.is_none());
    assert_eq!(row.5, Some(42));
    assert_eq!(row.6.as_deref(), Some("upstream"));
    assert_eq!(row.7.as_deref(), Some("claude-haiku"));
    assert_eq!(row.8, Some(1));
    let outcome = sqlx::query("SELECT last_status FROM session_outcomes WHERE session_id = ?")
        .bind("payload-off")
        .fetch_one(history.pool().unwrap())
        .await
        .unwrap();
    use sqlx::Row;
    assert_eq!(outcome.get::<String, _>("last_status"), "pass");
}

#[tokio::test]
async fn client_observe_columns_persist_before_model_rewrite() {
    use octo::history::{CostMicros, FinishedCall, Millis};

    let history = History::connect("sqlite::memory:", "test-token-key", 1024)
        .await
        .unwrap();
    history.record(FinishedCall {
        kind: CallKind::Messages,
        provider: CallProvider::OpenRouter,
        model: Some("mistralai/ministral-8b-2512".into()),
        token_hash: None,
        message: None,
        input: "{}".into(),
        output: "{}".into(),
        request_payload: "{}".into(),
        response_payload: "{}".into(),
        status: 200,
        latency_ms: Millis::new(1),
        request_bytes: 2,
        response_bytes: 2,
        input_tokens: None,
        output_tokens: None,
        cost: Some(CostMicros(1)),
        or_cost: None,
        upstream_cost: None,
        estimated_cost: None,
        cost_source: "none".into(),
        is_byok: None,
        upstream_provider: None,
        trimmed_from_tokens: None,
        client_model: Some("claude-haiku-4-5-20251001".into()),
        client_has_thinking: Some(true),
        client_tool_names: Some("Bash,Read".into()),
        bg_signal: Some(true),
        hk_text_signal: Some(false),
        cache_read_tokens: None,
        cache_write_tokens: None,
        generation_id: None,
        rerouting: 0,
        rerouting_reason: None,
        session_id: Some("observe-1".into()),
        tier_before: Some("low".into()),
        tier_after: Some("low".into()),
        trigger: "classify".into(),
    });
    history.drain().await;
    let row = poll_call(&history, || async {
        let row = sqlx::query(
            "SELECT client_model, client_has_thinking, client_tool_names, bg_signal, hk_text_signal, model FROM calls",
        )
        .fetch_optional(history.pool().unwrap())
        .await?;
        Ok(row.map(|row| {
            use sqlx::Row;
            (
                row.get::<Option<String>, _>("client_model"),
                row.get::<Option<i64>, _>("client_has_thinking"),
                row.get::<Option<String>, _>("client_tool_names"),
                row.get::<Option<i64>, _>("bg_signal"),
                row.get::<Option<i64>, _>("hk_text_signal"),
                row.get::<Option<String>, _>("model"),
            )
        }))
    })
    .await;
    assert_eq!(row.0.as_deref(), Some("claude-haiku-4-5-20251001"));
    assert_eq!(row.1, Some(1));
    assert_eq!(row.2.as_deref(), Some("Bash,Read"));
    assert_eq!(row.3, Some(1));
    assert_eq!(row.4, Some(0));
    assert_eq!(row.5.as_deref(), Some("mistralai/ministral-8b-2512"));
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
