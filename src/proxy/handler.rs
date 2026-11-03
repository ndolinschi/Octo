use axum::{
    body::{to_bytes, Body},
    extract::{Request, State},
    response::Response,
};

use crate::providers::decision::Decisions;
use crate::providers::llm::{ChatCompletions, Messages};
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
    let (provider, upstream_body) = resolve_chat_provider(
        path_hint,
        &body_bytes,
        state.default_chat_provider,
    );
    let request = Request::from_parts(parts, Body::from(upstream_body));
    match provider {
        ChatCompatProvider::OpenAi => {
            state
                .llm
                .openai
                .forward_chat_completions(&state.client, request)
                .await
        }
        ChatCompatProvider::OpenRouter => {
            state
                .llm
                .openrouter
                .forward_chat_completions(&state.client, request)
                .await
        }
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
    _path_hint: Option<MessagesProvider>,
) -> Result<Response, ProxyError> {
    state
        .llm
        .claude
        .forward_messages(&state.client, request)
        .await
}

pub async fn messages(
    State(state): State<AppState>,
    request: Request,
) -> Result<Response, ProxyError> {
    forward_messages(&state, request, Some(MessagesProvider::Claude)).await
}

pub async fn messages_claude(
    State(state): State<AppState>,
    request: Request,
) -> Result<Response, ProxyError> {
    forward_messages(&state, request, Some(MessagesProvider::Claude)).await
}

pub async fn messages_anthropic(
    State(state): State<AppState>,
    request: Request,
) -> Result<Response, ProxyError> {
    forward_messages(&state, request, Some(MessagesProvider::Claude)).await
}

pub async fn decisions(
    State(state): State<AppState>,
    request: Request,
) -> Result<Response, ProxyError> {
    state
        .decision
        .decisions
        .forward_decisions(&state.client, request)
        .await
}
