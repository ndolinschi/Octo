use axum::{
    body::{to_bytes, Body},
    extract::{Request, State},
    http::header,
    response::Response,
};
use futures_util::StreamExt;
use tracing::info;

use crate::providers::OpenAICompatible;
use crate::proxy::error::ProxyError;
use crate::state::AppState;

pub async fn chat_completions(
    State(state): State<AppState>,
    request: Request,
) -> Result<Response, ProxyError> {
    let max_body = state.provider.max_body_bytes();
    let upstream_url = state.provider.chat_completions_url();

    let (parts, body) = request.into_parts();
    let body_bytes = to_bytes(body, max_body)
        .await
        .map_err(ProxyError::ReadBody)?;
    let mut upstream = state.client.post(upstream_url).body(body_bytes);

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
