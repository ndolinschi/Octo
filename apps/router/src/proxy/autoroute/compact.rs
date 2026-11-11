use std::time::Instant;

use axum::{
    body::Body,
    http::{HeaderValue, StatusCode},
    response::Response,
};
use serde_json::Value;

use crate::auto::{
    new_request_id, parent_session_id, session_key, CallRow, Compact, Hints, PersistedCall,
};
use crate::history::{
    describe_input, request_payload, resolve_cost, response_payload, token_from_headers,
    usage_from_output, CallKind, CallProvider, FinishedCall, Millis,
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
    hints: &Hints,
) -> Result<Response, ProxyError> {
    let started = Instant::now();
    let (status, bytes, generation_id) = post(state, parts, &compact.body).await?;
    let (status, bytes, sent, generation_id) = if failed(status, &bytes) {
        if let Some(fallback) = &compact.fallback_model {
            let mut payload: Value = serde_json::from_slice(&compact.body).unwrap_or(Value::Null);
            if let Some(object) = payload.as_object_mut() {
                object.insert("model".to_string(), Value::String(fallback.clone()));
            }
            let next = serde_json::to_vec(&payload).unwrap_or_else(|_| compact.body.clone());
            let (status, bytes, generation_id) = post(state, parts, &next).await?;
            (status, bytes, next, generation_id)
        } else {
            (status, bytes, compact.body.clone(), generation_id)
        }
    } else {
        (status, bytes, compact.body.clone(), generation_id)
    };
    if let Some(id) = session_of_bytes(&sent) {
        let text = String::from_utf8_lossy(&bytes);
        if stop_reason_is(&text, "compaction")
            || stop_reason_is(&text, "model_context_window_exceeded")
        {
            state.auto.mark_awaiting_compact(&id);
        }
    }
    let request_id = new_request_id();
    let recorded = record(RecordPlan {
        state,
        parts,
        request_body: &sent,
        status,
        output: &bytes,
        started,
        header_generation_id: generation_id,
        hints,
        request_id: &request_id,
    });
    let mut response = Response::new(Body::from(bytes.to_vec()));
    *response.status_mut() = StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_GATEWAY);
    response.headers_mut().insert(
        axum::http::header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    let tier = state.auto.tiers().band(&recorded.model).to_string();
    let session = session_of_bytes(&sent);
    super::apply_result_headers(
        &mut response,
        &super::ResultInfo {
            model: Some(&recorded.model),
            tier: Some(&tier),
            trigger: "compact",
            request_id: &request_id,
            budget: state
                .auto
                .budget_status(session.as_deref(), hints.budget_key.as_deref()),
        },
    );
    Ok(response)
}

async fn post(
    state: &AppState,
    parts: &axum::http::request::Parts,
    body: &[u8],
) -> Result<(u16, Vec<u8>, Option<String>), ProxyError> {
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
    let generation_id = response
        .headers()
        .get("x-generation-id")
        .or_else(|| response.headers().get("request-id"))
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| value.starts_with("gen-"))
        .map(str::to_string);
    let bytes = response.bytes().await?.to_vec();
    Ok((status, bytes, generation_id))
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
    header_generation_id: Option<String>,
    hints: &'a Hints,
    request_id: &'a str,
}

struct Recorded {
    model: String,
}

fn record(plan: RecordPlan<'_>) -> Recorded {
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
    let resolved = resolve_cost(&usage, model.as_deref(), plan.state.history.prices());
    let session = session_of_bytes(plan.request_body);
    let parent = session
        .as_deref()
        .and_then(parent_session_id)
        .map(str::to_string);
    if let Some(cost) = resolved.cost {
        plan.state.auto.charge(
            &plan.state.history,
            session.as_deref(),
            plan.hints.budget_key.as_deref(),
            cost.0,
        );
    }
    let served = model.clone().unwrap_or_default();
    let row = CallRow {
        model: served.clone(),
        tier: plan.state.auto.tiers().band(&served).to_string(),
        trigger: "compact".to_string(),
        input_tokens: usage.input_tokens.map_or(0, |t| t.0),
        output_tokens: usage.output_tokens.map_or(0, |t| t.0),
        cache_read_tokens: usage.cache_read_tokens.map_or(0, |t| t.0),
        cache_write_tokens: usage.cache_write_tokens.map_or(0, |t| t.0),
        cost_usd: resolved.cost.map_or(0.0, |c| c.0 as f64 / 1_000_000.0),
        cost_source: crate::providers::utils::cost_source_label(resolved.source),
        route: None,
    };
    plan.state.auto.record_call_persisted(
        &plan.state.history,
        PersistedCall {
            request_id: plan.request_id.to_string(),
            session_id: session.clone(),
            budget_key: plan.hints.budget_key.clone(),
            row,
        },
    );
    let generation_id = plan.header_generation_id.or(usage.generation_id.clone());
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
        cost: resolved.cost,
        or_cost: resolved.or_cost,
        upstream_cost: resolved.upstream_cost,
        estimated_cost: resolved.estimated_cost,
        cost_source: resolved.source.as_str().to_string(),
        is_byok: resolved.is_byok,
        upstream_provider: resolved.upstream_provider,
        trimmed_from_tokens: None,
        client_model: None,
        client_has_thinking: None,
        client_tool_names: None,
        bg_signal: None,
        hk_text_signal: None,
        cache_read_tokens: usage.cache_read_tokens,
        cache_write_tokens: usage.cache_write_tokens,
        generation_id,
        rerouting: 0,
        rerouting_reason: Some("compact".to_string()),
        session_id: session,
        parent_session_id: parent,
        tier_before: None,
        tier_after: None,
        trigger: "compact".to_string(),
        request_id: Some(plan.request_id.to_string()),
    });
    Recorded { model: served }
}
