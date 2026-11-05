use std::time::Instant;

use axum::{
    body::Body,
    http::{HeaderValue, StatusCode},
    response::Response,
};
use serde_json::Value;

use crate::auto::{session_key, Compact};
use crate::history::{
    describe_input, request_payload, response_payload, token_from_headers, usage_from_output,
    CallKind, CallProvider, FinishedCall, Millis,
};
use crate::providers::openrouter::{apply_attribution, AttributionDefaults};
use crate::providers::utils::{apply_openrouter_messages_auth, forward_content_type};
use crate::proxy::error::ProxyError;
use crate::state::AppState;

use super::stop_reason_is;

pub(super) async fn upstream(
    state: &AppState,
    parts: &axum::http::request::Parts,
    compact: &Compact,
) -> Result<Response, ProxyError> {
    let started = Instant::now();
    let (status, bytes) = post(state, parts, &compact.body).await?;
    let (status, bytes, sent) = if failed(status, &bytes) {
        if let Some(fallback) = &compact.fallback_model {
            let mut payload: Value = serde_json::from_slice(&compact.body).unwrap_or(Value::Null);
            if let Some(object) = payload.as_object_mut() {
                object.insert("model".to_string(), Value::String(fallback.clone()));
            }
            let next = serde_json::to_vec(&payload).unwrap_or_else(|_| compact.body.clone());
            let (status, bytes) = post(state, parts, &next).await?;
            (status, bytes, next)
        } else {
            (status, bytes, compact.body.clone())
        }
    } else {
        (status, bytes, compact.body.clone())
    };
    if let Some(id) = session_of_bytes(&sent) {
        let text = String::from_utf8_lossy(&bytes);
        if stop_reason_is(&text, "compaction")
            || stop_reason_is(&text, "model_context_window_exceeded")
        {
            state.auto.mark_awaiting_compact(&id);
        }
    }
    record(RecordPlan {
        state,
        parts,
        request_body: &sent,
        status,
        output: &bytes,
        started,
    });
    let mut response = Response::new(Body::from(bytes.to_vec()));
    *response.status_mut() = StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_GATEWAY);
    response.headers_mut().insert(
        axum::http::header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    Ok(response)
}

async fn post(
    state: &AppState,
    parts: &axum::http::request::Parts,
    body: &[u8],
) -> Result<(u16, Vec<u8>), ProxyError> {
    let openrouter = AttributionDefaults::new(
        state.config.openrouter_http_referer.clone(),
        state.config.openrouter_title.clone(),
    );
    let mut request = state.client.post(state.llm.openrouter.messages_url());
    request = apply_openrouter_messages_auth(request, parts);
    request = apply_attribution(request, parts, &openrouter);
    request = match parts.headers.get("anthropic-version") {
        Some(value) => request.header("anthropic-version", value),
        None => request.header(
            "anthropic-version",
            state.config.anthropic_api_version.as_str(),
        ),
    };
    request = forward_content_type(request, parts);
    let response = request
        .header("anthropic-beta", "compact-2026-09-04")
        .body(body.to_vec())
        .send()
        .await?;
    let status = response.status().as_u16();
    let bytes = response.bytes().await?.to_vec();
    Ok((status, bytes))
}

fn failed(status: u16, body: &[u8]) -> bool {
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
    session_key(&value)
}

struct RecordPlan<'a> {
    state: &'a AppState,
    parts: &'a axum::http::request::Parts,
    request_body: &'a [u8],
    status: u16,
    output: &'a [u8],
    started: Instant,
}

fn record(plan: RecordPlan<'_>) {
    let input = String::from_utf8_lossy(plan.request_body).into_owned();
    let output_text = String::from_utf8_lossy(plan.output).into_owned();
    let (model, message) = describe_input(&input);
    let secret = token_from_headers(&plan.parts.headers);
    let token_hash = if secret.is_empty() {
        None
    } else {
        plan.state.history.token_hash(&secret).ok()
    };
    let usage = usage_from_output(&output_text);
    plan.state.history.record(FinishedCall {
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
            plan.output.len(),
        ),
        status: plan.status,
        latency_ms: Millis::new(plan.started.elapsed().as_millis() as u64),
        request_bytes: plan.request_body.len(),
        response_bytes: plan.output.len(),
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        cost: usage.cost,
        rerouting: 0,
        rerouting_reason: None,
    });
}
