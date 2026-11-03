use axum::{
    body::{to_bytes, Body},
    extract::{Request, State},
    http::{header, StatusCode},
    response::{IntoResponse, Response},
};
use futures_util::StreamExt;
use tracing::info;

use crate::state::AppState;

pub const UPSTREAM_CHAT_COMPLETIONS_URL: &str = "https://api.openai.com/v1/chat/completions";

const MAX_BODY_BYTES: usize = 10 * 1024 * 1024;

#[derive(Debug, thiserror::Error)]
pub enum ProxyError {
    #[error("failed to read request body")]
    ReadBody(#[source] axum::Error),
    #[error("upstream request failed")]
    Upstream(#[from] reqwest::Error),
    #[error("failed to build response")]
    BuildResponse,
}

impl IntoResponse for ProxyError {
    fn into_response(self) -> Response {
        let (status, message) = match &self {
            ProxyError::ReadBody(_) => (StatusCode::BAD_REQUEST, self.to_string()),
            ProxyError::Upstream(_) | ProxyError::BuildResponse => {
                (StatusCode::BAD_GATEWAY, self.to_string())
            }
        };
        (status, message).into_response()
    }
}

pub async fn chat_completions(
    State(state): State<AppState>,
    request: Request,
) -> Result<Response, ProxyError> {
    let (parts, body) = request.into_parts();
    let body_bytes = to_bytes(body, MAX_BODY_BYTES)
        .await
        .map_err(ProxyError::ReadBody)?;
    let mut upstream = state
        .client
        .post(UPSTREAM_CHAT_COMPLETIONS_URL)
        .body(body_bytes);

    if let Some(value) = parts.headers.get(header::AUTHORIZATION) {
        upstream = upstream.header(header::AUTHORIZATION, value);
    }

    match parts.headers.get(header::CONTENT_TYPE) {
        Some(value) => {
            upstream = upstream.header(header::CONTENT_TYPE, value);
        }
        None => {
            upstream = upstream.header(header::CONTENT_TYPE, "application/json");
        }
    }

    let upstream_response = upstream.send().await?;
    let status = upstream_response.status();
    info!(%status, "upstream responded");

    let mut response_builder = Response::builder().status(status);

    if let Some(content_type) = upstream_response.headers().get(header::CONTENT_TYPE) {
        response_builder = response_builder.header(header::CONTENT_TYPE, content_type);
    }

    if let Some(cache_control) = upstream_response.headers().get(header::CACHE_CONTROL) {
        response_builder = response_builder.header(header::CACHE_CONTROL, cache_control);
    }

    let stream = upstream_response
        .bytes_stream()
        .map(|chunk| chunk.map_err(std::io::Error::other));
    let body = Body::from_stream(stream);

    response_builder
        .body(body)
        .map_err(|_| ProxyError::BuildResponse)
}
