use axum::{
    extract::{Request, State},
    response::Response,
};

use crate::proxy::error::ProxyError;
use crate::state::AppState;

pub async fn chat_completions(
    State(state): State<AppState>,
    request: Request,
) -> Result<Response, ProxyError> {
    state
        .llm
        .openai
        .forward_chat_completions(&state.client, request)
        .await
}

pub async fn messages(
    State(state): State<AppState>,
    request: Request,
) -> Result<Response, ProxyError> {
    state
        .llm
        .anthropic
        .forward_messages(&state.client, request)
        .await
}

pub async fn decisions(
    State(state): State<AppState>,
    request: Request,
) -> Result<Response, ProxyError> {
    state
        .decision
        .openrouter
        .forward_decisions(&state.client, request)
        .await
}
