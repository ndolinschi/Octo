mod compact;

use std::sync::Arc;

use axum::{
    body::{to_bytes, Body, Bytes},
    extract::{Request, State},
    http::StatusCode,
    response::Response,
};
use serde_json::Value;

use crate::auto::{session_key, Compact, DecideRequest, Turn};
use crate::history::{token_from_headers, CallKind, CallObserve, CallProvider};
use crate::proxy::error::ProxyError;
use crate::state::AppState;

pub async fn messages(
    State(state): State<AppState>,
    request: Request,
) -> Result<Response, ProxyError> {
    run(&state, request, false)
        .await
        .map_err(ProxyError::as_anthropic_messages)
}

pub async fn chat(State(state): State<AppState>, request: Request) -> Result<Response, ProxyError> {
    run(&state, request, true).await
}

async fn run(state: &AppState, request: Request, chat: bool) -> Result<Response, ProxyError> {
    let max_body = state.config.max_body_bytes;
    let (parts, body) = request.into_parts();
    let body_bytes = to_bytes(body, max_body)
        .await
        .map_err(ProxyError::from_read_body)?;
    let api_key = token_from_headers(&parts.headers);
    let value: Value = serde_json::from_slice(&body_bytes).unwrap_or(Value::Null);
    let session = session_key(&value);
    let turn = crate::auto::decide(DecideRequest {
        auto: &state.auto,
        history: &state.history,
        client: &state.client,
        decisions_url: &state.config.openrouter_decisions_url,
        api_key: &api_key,
        body: value,
        allow_compact: !chat,
    })
    .await;
    match turn {
        Turn::Forward(forward) => {
            forward_turn(ForwardTurn {
                state,
                parts,
                forward,
                session,
                chat,
            })
            .await
        }
        Turn::Compact(row) if chat => chat_compact(state, parts, row).await,
        Turn::Compact(row) => compact::upstream(state, &parts, &row).await,
    }
}

struct ForwardTurn<'a> {
    state: &'a AppState,
    parts: axum::http::request::Parts,
    forward: crate::auto::Forward,
    session: Option<String>,
    chat: bool,
}

async fn forward_turn(plan: ForwardTurn<'_>) -> Result<Response, ProxyError> {
    let ForwardTurn {
        state,
        parts,
        forward,
        session,
        chat,
    } = plan;
    let retry_parts = clone_parts(&parts);
    let retry_forward = forward.clone();
    let first = dispatch_forward(DispatchForward {
        state,
        parts,
        forward,
        session: session.clone(),
        chat,
    })
    .await;
    match first {
        Ok(response) if !chat && retryable_status(response.status()) => {
            if let Some(retried) = retry_next_tier(RetryNext {
                state,
                parts: retry_parts,
                forward: retry_forward,
                session,
                chat,
            })
            .await
            {
                return retried;
            }
            Ok(response)
        }
        Err(err) if !chat && retryable_error(&err) => {
            if let Some(retried) = retry_next_tier(RetryNext {
                state,
                parts: retry_parts,
                forward: retry_forward,
                session,
                chat,
            })
            .await
            {
                return retried;
            }
            Err(err)
        }
        other => other,
    }
}

struct RetryNext<'a> {
    state: &'a AppState,
    parts: axum::http::request::Parts,
    forward: crate::auto::Forward,
    session: Option<String>,
    chat: bool,
}

async fn retry_next_tier(plan: RetryNext<'_>) -> Option<Result<Response, ProxyError>> {
    let payload: Value = serde_json::from_slice(&plan.forward.body).ok()?;
    let current = payload.get("model").and_then(Value::as_str)?.to_string();
    let next = plan.state.auto.tiers().next_up(&current)?;
    let models = plan.state.auto.cached_models().await;
    let shaped = crate::auto::shape(crate::auto::ShapePlan {
        body: &payload,
        model: &next,
        previous_model: Some(current.as_str()),
        models: models.as_ref(),
    });
    let body = serde_json::to_vec(&shaped).ok()?;
    let forward = crate::auto::Forward {
        body,
        rerouting: 1,
        reason: Some("upstream_retry".to_string()),
    };
    Some(
        dispatch_forward(DispatchForward {
            state: plan.state,
            parts: plan.parts,
            forward,
            session: plan.session,
            chat: plan.chat,
        })
        .await,
    )
}

struct DispatchForward<'a> {
    state: &'a AppState,
    parts: axum::http::request::Parts,
    forward: crate::auto::Forward,
    session: Option<String>,
    chat: bool,
}

async fn dispatch_forward(plan: DispatchForward<'_>) -> Result<Response, ProxyError> {
    let hook = (!plan.chat).then_some(plan.session).flatten().map(|id| {
        let auto = plan.state.auto.clone();
        Arc::new(move |text: &str| {
            if stop_reason_is(text, "model_context_window_exceeded") {
                auto.mark_awaiting_compact(&id);
            }
        }) as Arc<dyn Fn(&str) + Send + Sync>
    });
    let observe = Some(CallObserve {
        history: plan.state.history.clone(),
        kind: if plan.chat {
            CallKind::Llm
        } else {
            CallKind::Messages
        },
        provider: CallProvider::OpenRouter,
        rerouting: plan.forward.rerouting,
        rerouting_reason: plan.forward.reason.clone(),
        on_response: hook,
    });
    if plan.chat {
        plan.state
            .llm
            .openrouter
            .forward_chat_buffered(
                &plan.state.client,
                plan.parts,
                Bytes::from(plan.forward.body),
                observe,
            )
            .await
    } else {
        let request = Request::from_parts(plan.parts, Body::from(plan.forward.body));
        plan.state
            .llm
            .openrouter
            .forward_messages(&plan.state.client, request, observe)
            .await
    }
}

fn clone_parts(parts: &axum::http::request::Parts) -> axum::http::request::Parts {
    let mut cloned = Request::new(Body::empty()).into_parts().0;
    cloned.method = parts.method.clone();
    cloned.uri = parts.uri.clone();
    cloned.version = parts.version;
    cloned.headers = parts.headers.clone();
    cloned
}

fn retryable_status(status: StatusCode) -> bool {
    status.as_u16() == 429 || status.is_server_error()
}

fn retryable_error(err: &ProxyError) -> bool {
    matches!(err, ProxyError::Upstream(source) if source.is_connect() || source.is_timeout())
}

async fn chat_compact(
    state: &AppState,
    parts: axum::http::request::Parts,
    compact: Compact,
) -> Result<Response, ProxyError> {
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

pub(super) fn stop_reason_is(text: &str, reason: &str) -> bool {
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
