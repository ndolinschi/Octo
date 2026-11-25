//! An upstream SSE stream that ends without its terminator, or breaks off, must not look like a complete answer:
//! the client gets the provider's own error event before the stream closes, and the history row is a failed call.

mod support;

use axum::{body::Body, http::Request};
use futures_util::StreamExt;
use octo::history::{CallKind, CallObserve, CallProvider, History};
use octo::providers::utils::{forward_content_type, proxy_post};
use sqlx::Row;
use support::{spawn_sse_server, StreamEnd};

const MSG_START: &str = "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":100,\"output_tokens\":1}}}\n\n";
const MSG_DELTA: &str = "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"Hello\"}}\n\n";
const MSG_STOP: &str = "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n";
const CHAT_CHUNK: &str = "data: {\"choices\":[{\"delta\":{\"content\":\"Hi\"}}]}\n\n";

fn observe(history: &History, kind: CallKind) -> CallObserve {
    CallObserve {
        history: history.clone(),
        kind,
        provider: CallProvider::OpenRouter,
        rerouting: 0,
        rerouting_reason: None,
        session_id: None,
        tier_before: None,
        tier_after: None,
        decided_tier: None,
        trigger: "none".to_string(),
        trimmed_from_tokens: None,
        client_model: None,
        client_has_thinking: None,
        client_tool_names: None,
        bg_signal: None,
        hk_text_signal: None,
        auto: None,
        on_response: None,
        request_id: None,
        budget_key: None,
    }
}

/// Runs one call through the relay: (what the client received, the status the history recorded).
async fn relay(kind: CallKind, upstream_body: &str, end: StreamEnd) -> (String, i64) {
    let addr = spawn_sse_server(upstream_body, end).await;
    let history = History::connect("sqlite::memory:", "test-token-key", 1 << 20)
        .await
        .unwrap();
    let client = reqwest::Client::builder().build().unwrap();
    let request = Request::builder()
        .method("POST")
        .uri("http://127.0.0.1:8080/v1/messages")
        .body(Body::from(
            r#"{"model":"some/model","stream":true,"messages":[]}"#,
        ))
        .unwrap();
    let response = proxy_post(
        &client,
        &format!("http://{addr}/stream"),
        4096,
        request,
        forward_content_type,
        Some(observe(&history, kind)),
    )
    .await
    .unwrap();
    assert_eq!(
        response.status(),
        200,
        "the client already saw success headers"
    );
    let mut stream = response.into_body().into_data_stream();
    let mut received = Vec::new();
    while let Some(chunk) = stream.next().await {
        // A body error would abort the client's connection with no event at all.
        received.extend_from_slice(&chunk.expect("the relayed body must end cleanly"));
    }
    drop(stream);
    let mut status = None;
    for _ in 0..100 {
        if let Some(row) = sqlx::query("SELECT status FROM calls")
            .fetch_optional(history.pool().unwrap())
            .await
            .unwrap()
        {
            status = Some(row.get::<i64, _>("status"));
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    (
        String::from_utf8_lossy(&received).into_owned(),
        status.expect("a call row"),
    )
}

fn error_event_of(received: &str) -> serde_json::Value {
    let at = received
        .find("event: error\ndata: ")
        .unwrap_or_else(|| panic!("no error event in {received:?}"));
    let data = received[at + "event: error\ndata: ".len()..]
        .lines()
        .next()
        .unwrap();
    serde_json::from_str(data).unwrap()
}

#[tokio::test]
async fn a_messages_stream_cut_by_the_connection_ends_with_an_error_event_and_a_failed_row() {
    let partial = format!("{MSG_START}{MSG_DELTA}");
    let (received, status) = relay(CallKind::Messages, &partial, StreamEnd::Cut).await;
    assert!(received.starts_with(&partial), "{received:?}");
    let event = error_event_of(&received);
    assert_eq!(event["type"], "error");
    assert_eq!(event["error"]["type"], "api_error");
    assert!(
        event["error"]["message"]
            .as_str()
            .unwrap()
            .contains("broke off"),
        "{event}"
    );
    assert!(received.ends_with("\n\n"));
    assert_eq!(status, 502, "recorded as a failed call");
}

#[tokio::test]
async fn a_messages_stream_that_just_stops_ends_with_an_error_event_and_a_failed_row() {
    // The connection closes cleanly after a complete event, but message_stop never came.
    let partial = format!("{MSG_START}{MSG_DELTA}");
    let (received, status) = relay(CallKind::Messages, &partial, StreamEnd::Clean).await;
    assert!(received.starts_with(&partial), "{received:?}");
    assert_eq!(error_event_of(&received)["error"]["type"], "api_error");
    assert_eq!(status, 502);
}

#[tokio::test]
async fn a_stream_cut_in_the_middle_of_an_event_still_gets_a_well_formed_error_event() {
    let partial = format!("{MSG_START}event: content_block_delta\ndata: {{\"type\":\"content_bl");
    let (received, _) = relay(CallKind::Messages, &partial, StreamEnd::Cut).await;
    assert!(
        received.contains("content_bl\n\nevent: error\ndata: "),
        "{received:?}"
    );
    assert_eq!(error_event_of(&received)["type"], "error");
}

#[tokio::test]
async fn a_complete_messages_stream_is_relayed_untouched_and_recorded_as_ok() {
    let whole = format!("{MSG_START}{MSG_DELTA}{MSG_STOP}");
    let (received, status) = relay(CallKind::Messages, &whole, StreamEnd::Clean).await;
    assert_eq!(received, whole);
    assert_eq!(status, 200);
}

#[tokio::test]
async fn an_error_event_the_upstream_sent_itself_is_not_followed_by_a_second_one() {
    let own = "event: error\ndata: {\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\",\"message\":\"Overloaded\"}}\n\n";
    let body = format!("{MSG_START}{own}");
    let (received, _) = relay(CallKind::Messages, &body, StreamEnd::Clean).await;
    assert_eq!(received, body);
}

#[tokio::test]
async fn a_chat_stream_without_done_ends_with_an_error_chunk_and_a_complete_one_is_untouched() {
    let partial = CHAT_CHUNK.to_string();
    let (received, status) = relay(CallKind::Llm, &partial, StreamEnd::Cut).await;
    assert!(received.starts_with(&partial), "{received:?}");
    let tail = &received[partial.len()..];
    let data = tail
        .strip_prefix("data: ")
        .expect(tail)
        .lines()
        .next()
        .unwrap();
    let v: serde_json::Value = serde_json::from_str(data).unwrap();
    assert!(
        v["error"]["message"]
            .as_str()
            .unwrap()
            .contains("broke off"),
        "{v}"
    );
    assert_eq!(status, 502);

    let whole = format!("{CHAT_CHUNK}data: [DONE]\n\n");
    let (received, status) = relay(CallKind::Llm, &whole, StreamEnd::Clean).await;
    assert_eq!(received, whole);
    assert_eq!(status, 200);
}
