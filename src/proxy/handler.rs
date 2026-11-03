use axum::{
    extract::{Request, State},
    response::Response,
};

use crate::providers::OpenAICompatible;
use crate::proxy::error::ProxyError;
use crate::state::AppState;

pub async fn chat_completions(
    State(state): State<AppState>,
    request: Request,
) -> Result<Response, ProxyError> {
    state
        .provider
        .forward_chat_completions(&state.client, request)
        .await
}
