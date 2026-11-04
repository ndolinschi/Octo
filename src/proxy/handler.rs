use axum::{
    body::{to_bytes, Bytes},
    extract::{Request, State},
    http::StatusCode,
    response::{IntoResponse, Response},
};

use crate::history::CallObserve;
use crate::providers::llm::Messages;
use crate::proxy::error::ProxyError;
use crate::proxy::select::{resolve_chat_provider, ChatCompatProvider, MessagesProvider};
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
    let (provider_name, forward) = match provider {
        ChatCompatProvider::OpenAi => ("openai", true),
        ChatCompatProvider::OpenRouter => ("openrouter", false),
    };
    let observe = Some(CallObserve {
        history: state.history.clone(),
        kind: "llm",
        provider: provider_name,
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

async fn forward_messages(state: &AppState, request: Request) -> Result<Response, ProxyError> {
    match state.messages_provider {
        MessagesProvider::Claude => {
            state
                .llm
                .claude
                .forward_messages(
                    &state.client,
                    request,
                    Some(CallObserve {
                        history: state.history.clone(),
                        kind: "llm",
                        provider: "claude",
                    }),
                )
                .await
        }
    }
}

pub async fn messages(
    State(state): State<AppState>,
    request: Request,
) -> Result<Response, ProxyError> {
    forward_messages(&state, request).await
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
                kind: "decision",
                provider: "openrouter",
            }),
        )
        .await
}

pub async fn health() -> impl IntoResponse {
    StatusCode::OK
}
