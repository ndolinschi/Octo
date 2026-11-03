use axum::{
    extract::{Request, State},
    response::Response,
};

use crate::providers::decision::DecisionsForward;
use crate::providers::llm::{ChatCompletionsForward, MessagesForward};
use crate::proxy::error::ProxyError;
use crate::state::AppState;

pub async fn chat_completions(
    State(state): State<AppState>,
    request: Request,
) -> Result<Response, ProxyError> {
    state
        .llm
        .chat
        .forward_chat_completions(&state.client, request)
        .await
}

pub async fn messages(
    State(state): State<AppState>,
    request: Request,
) -> Result<Response, ProxyError> {
    state
        .llm
        .messages
        .forward_messages(&state.client, request)
        .await
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
