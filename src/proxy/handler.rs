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
        .openai
        .forward_chat_completions(&state.client, request)
        .await
}

pub async fn messages(
    State(state): State<AppState>,
    request: Request,
) -> Result<Response, ProxyError> {
    state
        .anthropic
        .forward_messages(&state.client, request)
        .await
}
