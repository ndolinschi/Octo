use axum::{
    body::{to_bytes, Body, Bytes},
    extract::{Request, State},
    response::IntoResponse,
};

use crate::history::{CallKind, CallObserve, CallProvider};
use crate::proxy::error::ProxyError;
use crate::proxy::select::{
    resolve_chat_provider, resolve_messages_provider, ChatCompatProvider, MessagesProvider,
};
use crate::state::AppState;

async fn forward_chat(
    state: &AppState,
    request: Request,
    path_hint: Option<ChatCompatProvider>,
) -> Result<axum::response::Response, ProxyError> {
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
) -> Result<axum::response::Response, ProxyError> {
    forward_chat(&state, request, None).await
}

pub async fn chat_completions_openai(
    State(state): State<AppState>,
    request: Request,
) -> Result<axum::response::Response, ProxyError> {
    forward_chat(&state, request, Some(ChatCompatProvider::OpenAi)).await
}

pub async fn chat_completions_openrouter(
    State(state): State<AppState>,
    request: Request,
) -> Result<axum::response::Response, ProxyError> {
    forward_chat(&state, request, Some(ChatCompatProvider::OpenRouter)).await
}

async fn forward_messages(
    state: &AppState,
    request: Request,
    path_hint: Option<MessagesProvider>,
) -> Result<axum::response::Response, ProxyError> {
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
) -> Result<axum::response::Response, ProxyError> {
    forward_messages(&state, request, None)
        .await
        .map_err(ProxyError::as_anthropic_messages)
}

pub async fn messages_claude(
    State(state): State<AppState>,
    request: Request,
) -> Result<axum::response::Response, ProxyError> {
    forward_messages(&state, request, Some(MessagesProvider::Claude))
        .await
        .map_err(ProxyError::as_anthropic_messages)
}

pub async fn messages_openrouter(
    State(state): State<AppState>,
    request: Request,
) -> Result<axum::response::Response, ProxyError> {
    forward_messages(&state, request, Some(MessagesProvider::OpenRouter))
        .await
        .map_err(ProxyError::as_anthropic_messages)
}

pub async fn decisions(
    State(state): State<AppState>,
    request: Request,
) -> Result<axum::response::Response, ProxyError> {
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
            }),
        )
        .await
}

pub const CAPABILITIES: [&str; 5] = [
    "autoroute",
    "route_hints",
    "result_headers",
    "budget_key",
    "route_api",
];

pub async fn health() -> impl IntoResponse {
    axum::Json(serde_json::json!({
        "status": "ok",
        "service": "octo",
        "version": env!("CARGO_PKG_VERSION"),
        "capabilities": CAPABILITIES,
    }))
}
