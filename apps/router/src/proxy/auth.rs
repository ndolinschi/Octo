use axum::{
    extract::{Request, State},
    http::StatusCode,
    middleware::Next,
    response::{IntoResponse, Response},
};
use subtle::ConstantTimeEq;

use crate::state::AppState;

fn client_key_matches(expected: &str, provided: &str) -> bool {
    expected.as_bytes().ct_eq(provided.as_bytes()).into()
}

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
    let authorized = provided.is_some_and(|provided| client_key_matches(expected, provided));
    if !authorized {
        return (StatusCode::UNAUTHORIZED, "missing or invalid x-octo-key").into_response();
    }
    next.run(request).await
}
