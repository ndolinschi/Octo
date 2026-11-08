use axum::{
    extract::{Request, State},
    http::StatusCode,
    middleware::Next,
    response::{IntoResponse, Response},
};

use crate::state::AppState;

pub async fn require_client_auth(
    State(state): State<AppState>,
    request: Request,
    next: Next,
) -> Response {
    let expected = state.config.client_auth_key.trim();
    if expected.is_empty() || request.uri().path() == "/health" {
        return next.run(request).await;
    }
    let provided = request
        .headers()
        .get("x-octo-key")
        .and_then(|v| v.to_str().ok());
    if provided != Some(expected) {
        return (StatusCode::UNAUTHORIZED, "missing or invalid x-octo-key").into_response();
    }
    next.run(request).await
}
