use axum::{
    body::to_bytes,
    extract::{Request, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};

use crate::auto::{delegate_route, RouteError, RouteInput, RouteRequest};
use crate::history::token_from_headers;
use crate::proxy::error::ProxyError;
use crate::state::AppState;

pub async fn route(
    State(state): State<AppState>,
    request: Request,
) -> Result<Response, ProxyError> {
    let (parts, body) = request.into_parts();
    let bytes = to_bytes(body, state.config.max_body_bytes)
        .await
        .map_err(|err| ProxyError::from_read_body(err).as_anthropic_messages())?;
    let parsed: RouteRequest = serde_json::from_slice(&bytes).map_err(|err| {
        ProxyError::anthropic(
            StatusCode::BAD_REQUEST,
            "invalid_request_error",
            format!("invalid route request: {err}"),
        )
    })?;
    let api_key = token_from_headers(&parts.headers);
    let routed = delegate_route(
        RouteInput {
            auto: &state.auto,
            history: &state.history,
            client: &state.client,
            decisions_url: &state.config.openrouter_decisions_url,
            api_key: &api_key,
        },
        parsed,
    )
    .await;
    match routed {
        Ok(response) => Ok(Json(response).into_response()),
        Err(RouteError::Invalid(message)) => Err(ProxyError::anthropic(
            StatusCode::UNPROCESSABLE_ENTITY,
            "invalid_request_error",
            message,
        )),
        Err(RouteError::Budget(reject)) => Err(ProxyError::anthropic(
            StatusCode::PAYMENT_REQUIRED,
            "billing_error",
            reject.message(),
        )),
    }
}
