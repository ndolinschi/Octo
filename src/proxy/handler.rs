use std::time::Instant;

use axum::{
    body::{to_bytes, Body, Bytes},
    extract::{Request, State},
    http::{HeaderValue, StatusCode},
    response::{IntoResponse, Response},
};
use serde_json::Value;

use std::sync::Arc;

use crate::auto::{decide, session_id, Compact, Turn};
use crate::history::{
    describe_input, request_payload, response_payload, token_from_headers, usage_from_output,
    CallKind, CallObserve, CallProvider, FinishedCall, Millis,
};
use crate::proxy::error::ProxyError;
use crate::proxy::select::{
    resolve_chat_provider, resolve_messages_provider, ChatCompatProvider, MessagesProvider,
};
use crate::state::AppState;

async fn forward_chat(
    state: &AppState,
    request: Request,
    path_hint: Option<ChatCompatProvider>,
) -> Result<Response, ProxyError> {
    let max_body = state.config.max_body_bytes;
    let (parts, body) = request.into_parts();
    let body_bytes = to_bytes(body, max_body)
        .await
        .map_err(ProxyError::from_read_body)?;
    let (provider, upstream_body) =
        resolve_chat_provider(path_hint, &body_bytes, state.default_chat_provider)?;
    let body_bytes = Bytes::from(upstream_body);
    let forward = matches!(provider, ChatCompatProvider::OpenAi);
    let observe = Some(CallObserve {
        history: state.history.clone(),
        kind: CallKind::Llm,
        provider: CallProvider::from(provider),
        rerouting: 0,
        rerouting_reason: None,
        on_response: None,
    });
    if forward {
        state
            .llm
            .openai
            .forward_chat_buffered(&state.client, parts, body_bytes, observe)
            .await
    } else {
        state
            .llm
            .openrouter
            .forward_chat_buffered(&state.client, parts, body_bytes, observe)
            .await
    }
}

pub async fn chat_completions(
    State(state): State<AppState>,
    request: Request,
) -> Result<Response, ProxyError> {
    forward_chat(&state, request, None).await
}

pub async fn chat_completions_openai(
    State(state): State<AppState>,
    request: Request,
) -> Result<Response, ProxyError> {
    forward_chat(&state, request, Some(ChatCompatProvider::OpenAi)).await
}

pub async fn chat_completions_openrouter(
    State(state): State<AppState>,
    request: Request,
) -> Result<Response, ProxyError> {
    forward_chat(&state, request, Some(ChatCompatProvider::OpenRouter)).await
}

async fn forward_messages(
    state: &AppState,
    request: Request,
    path_hint: Option<MessagesProvider>,
) -> Result<Response, ProxyError> {
    let max_body = state.config.max_body_bytes;
    let (parts, body) = request.into_parts();
    let body_bytes = to_bytes(body, max_body)
        .await
        .map_err(ProxyError::from_read_body)?;
    let (provider, upstream_body) =
        resolve_messages_provider(path_hint, &body_bytes, state.default_messages_provider)?;
    let request = Request::from_parts(parts, Body::from(upstream_body));
    let observe = Some(CallObserve {
        history: state.history.clone(),
        kind: CallKind::Messages,
        provider: CallProvider::from(provider),
        rerouting: 0,
        rerouting_reason: None,
        on_response: None,
    });
    match provider {
        MessagesProvider::Claude => {
            state
                .llm
                .claude
                .forward_messages(&state.client, request, observe)
                .await
        }
        MessagesProvider::OpenRouter => {
            state
                .llm
                .openrouter
                .forward_messages(&state.client, request, observe)
                .await
        }
    }
}

pub async fn messages(
    State(state): State<AppState>,
    request: Request,
) -> Result<Response, ProxyError> {
    forward_messages(&state, request, None).await
}

pub async fn messages_claude(
    State(state): State<AppState>,
    request: Request,
) -> Result<Response, ProxyError> {
    forward_messages(&state, request, Some(MessagesProvider::Claude)).await
}

pub async fn messages_openrouter(
    State(state): State<AppState>,
    request: Request,
) -> Result<Response, ProxyError> {
    forward_messages(&state, request, Some(MessagesProvider::OpenRouter)).await
}

pub async fn decisions(
    State(state): State<AppState>,
    request: Request,
) -> Result<Response, ProxyError> {
    state
        .decision
        .openrouter
        .forward_decisions(
            &state.client,
            request,
            Some(CallObserve {
                history: state.history.clone(),
                kind: CallKind::Decision,
                provider: CallProvider::OpenRouter,
                rerouting: 0,
                rerouting_reason: None,
                on_response: None,
            }),
        )
        .await
}

pub async fn health() -> impl IntoResponse {
    StatusCode::OK
}

pub async fn autoroute_messages(
    State(state): State<AppState>,
    request: Request,
) -> Result<Response, ProxyError> {
    autoroute(&state, request, false).await
}

pub async fn autoroute_chat(
    State(state): State<AppState>,
    request: Request,
) -> Result<Response, ProxyError> {
    autoroute(&state, request, true).await
}

async fn autoroute(state: &AppState, request: Request, chat: bool) -> Result<Response, ProxyError> {
    let max_body = state.config.max_body_bytes;
    let (parts, body) = request.into_parts();
    let body_bytes = to_bytes(body, max_body)
        .await
        .map_err(ProxyError::from_read_body)?;
    let api_key = token_from_headers(&parts.headers);
    let value: Value = serde_json::from_slice(&body_bytes).unwrap_or(Value::Null);
    let session = session_id(&value);
    let turn = decide(
        &state.auto,
        &state.client,
        &state.config.openrouter_decisions_url,
        &api_key,
        value,
        !chat,
    )
    .await;
    match turn {
        Turn::Forward(forward) => {
            let hook = session.clone().map(|id| {
                let auto = state.auto.clone();
                Arc::new(move |text: &str| {
                    if stop_reason_is(text, "model_context_window_exceeded") {
                        auto.mark_awaiting_compact(&id);
                    }
                }) as Arc<dyn Fn(&str) + Send + Sync>
            });
            let observe = Some(CallObserve {
                history: state.history.clone(),
                kind: if chat {
                    CallKind::Llm
                } else {
                    CallKind::Messages
                },
                provider: CallProvider::OpenRouter,
                rerouting: forward.rerouting,
                rerouting_reason: forward.reason.clone(),
                on_response: hook,
            });
            let request = Request::from_parts(parts, Body::from(forward.body));
            if chat {
                let (parts, body) = request.into_parts();
                let bytes = to_bytes(body, max_body)
                    .await
                    .map_err(ProxyError::from_read_body)?;
                state
                    .llm
                    .openrouter
                    .forward_chat_buffered(&state.client, parts, bytes, observe)
                    .await
            } else {
                state
                    .llm
                    .openrouter
                    .forward_messages(&state.client, request, observe)
                    .await
            }
        }
        Turn::Compact(compact) if chat => {
            let mut payload: Value = serde_json::from_slice(&compact.body).unwrap_or(Value::Null);
            if let Some(object) = payload.as_object_mut() {
                object.remove("compaction");
            }
            let bytes = Bytes::from(serde_json::to_vec(&payload).unwrap_or(compact.body));
            state
                .llm
                .openrouter
                .forward_chat_buffered(
                    &state.client,
                    parts,
                    bytes,
                    Some(CallObserve {
                        history: state.history.clone(),
                        kind: CallKind::Llm,
                        provider: CallProvider::OpenRouter,
                        rerouting: 0,
                        rerouting_reason: None,
                        on_response: None,
                    }),
                )
                .await
        }
        Turn::Compact(compact) => compact_upstream(state, &parts, &compact).await,
    }
}

async fn compact_upstream(
    state: &AppState,
    parts: &axum::http::request::Parts,
    compact: &Compact,
) -> Result<Response, ProxyError> {
    let started = Instant::now();
    let (status, bytes) = post_compact(state, parts, &compact.body).await?;
    let (status, bytes, sent) = if compact_failed(status, &bytes) {
        if let Some(fallback) = &compact.fallback_model {
            let mut payload: Value = serde_json::from_slice(&compact.body).unwrap_or(Value::Null);
            if let Some(object) = payload.as_object_mut() {
                object.insert("model".to_string(), Value::String(fallback.clone()));
            }
            let next = serde_json::to_vec(&payload).unwrap_or_else(|_| compact.body.clone());
            let (status, bytes) = post_compact(state, parts, &next).await?;
            (status, bytes, next)
        } else {
            (status, bytes, compact.body.clone())
        }
    } else {
        (status, bytes, compact.body.clone())
    };
    if let Some(id) = session_of_bytes(&sent) {
        if stop_reason_is(&String::from_utf8_lossy(&bytes), "compaction")
            || stop_reason_is(
                &String::from_utf8_lossy(&bytes),
                "model_context_window_exceeded",
            )
        {
            state.auto.mark_awaiting_compact(&id);
        } else {
            state.auto.clear_awaiting_compact(&id);
        }
    }
    record_compact(state, parts, &sent, status, &bytes, started);
    let mut response = Response::new(Body::from(bytes.to_vec()));
    *response.status_mut() = StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_GATEWAY);
    response.headers_mut().insert(
        axum::http::header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    Ok(response)
}

async fn post_compact(
    state: &AppState,
    parts: &axum::http::request::Parts,
    body: &[u8],
) -> Result<(u16, Vec<u8>), ProxyError> {
    let secret = token_from_headers(&parts.headers);
    let mut request = state
        .client
        .post(state.llm.openrouter.messages_url())
        .header("anthropic-beta", "compact-2026-09-04")
        .header(
            "anthropic-version",
            parts
                .headers
                .get("anthropic-version")
                .and_then(|value| value.to_str().ok())
                .unwrap_or(state.config.anthropic_api_version.as_str()),
        )
        .header(axum::http::header::CONTENT_TYPE, "application/json")
        .bearer_auth(secret)
        .body(body.to_vec());
    if let Some(value) = parts.headers.get("http-referer") {
        request = request.header("http-referer", value);
    }
    if let Some(value) = parts.headers.get("x-title") {
        request = request.header("x-title", value);
    }
    let response = request.send().await?;
    let status = response.status().as_u16();
    let bytes = response.bytes().await?.to_vec();
    Ok((status, bytes))
}

fn stop_reason_is(text: &str, reason: &str) -> bool {
    if let Ok(value) = serde_json::from_str::<Value>(text) {
        return value.get("stop_reason").and_then(Value::as_str) == Some(reason);
    }
    text.lines().any(|line| {
        let data = line.strip_prefix("data: ").unwrap_or(line);
        serde_json::from_str::<Value>(data)
            .ok()
            .and_then(|value| {
                value
                    .get("stop_reason")
                    .or_else(|| {
                        value
                            .get("delta")
                            .and_then(|delta| delta.get("stop_reason"))
                    })
                    .and_then(Value::as_str)
                    .map(|found| found == reason)
            })
            .unwrap_or(false)
    })
}

fn compact_failed(status: u16, body: &[u8]) -> bool {
    if !(200..300).contains(&status) {
        return true;
    }
    let Ok(value) = serde_json::from_slice::<Value>(body) else {
        return true;
    };
    value.get("stop_reason").and_then(Value::as_str) == Some("model_context_window_exceeded")
}

fn session_of_bytes(body: &[u8]) -> Option<String> {
    let value: Value = serde_json::from_slice(body).ok()?;
    session_id(&value)
}

fn record_compact(
    state: &AppState,
    parts: &axum::http::request::Parts,
    request_body: &[u8],
    status: u16,
    output: &[u8],
    started: Instant,
) {
    let input = String::from_utf8_lossy(request_body).into_owned();
    let output_text = String::from_utf8_lossy(output).into_owned();
    let (model, message) = describe_input(&input);
    let secret = token_from_headers(&parts.headers);
    let token_hash = if secret.is_empty() {
        None
    } else {
        state.history.token_hash(&secret).ok()
    };
    let usage = usage_from_output(&output_text);
    state.history.record(FinishedCall {
        kind: CallKind::Messages,
        provider: CallProvider::OpenRouter,
        model,
        token_hash,
        message,
        input: input.clone(),
        output: output_text.clone(),
        request_payload: request_payload(CallKind::Messages, CallProvider::OpenRouter, &input),
        response_payload: response_payload(
            CallKind::Messages,
            CallProvider::OpenRouter,
            &output_text,
            "",
            output.len(),
        ),
        status,
        latency_ms: Millis::new(started.elapsed().as_millis() as u64),
        request_bytes: request_body.len(),
        response_bytes: output.len(),
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        cost: usage.cost,
        rerouting: 0,
        rerouting_reason: None,
    });
}
