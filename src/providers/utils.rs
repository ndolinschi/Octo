use axum::{
    body::{to_bytes, Body},
    http::{header, request::Parts, HeaderName, Request, Response},
};
use futures_util::StreamExt;
use reqwest::{Client, RequestBuilder};
use tracing::info;

use crate::proxy::error::ProxyError;

fn should_forward_response_header(name: &HeaderName) -> bool {
    if name == header::CONTENT_TYPE || name == header::CACHE_CONTROL {
        return true;
    }
    let name = name.as_str();
    name == "x-request-id"
        || name == "retry-after"
        || name.starts_with("openai-")
        || name.starts_with("x-ratelimit-")
        || name.starts_with("anthropic-ratelimit-")
}

pub async fn upstream_to_response(
    upstream: reqwest::Response,
) -> Result<Response<Body>, ProxyError> {
    let status = upstream.status();
    info!(%status, "upstream responded");

    let mut response_builder = Response::builder().status(status);

    for (name, value) in upstream.headers() {
        if should_forward_response_header(name) {
            response_builder = response_builder.header(name, value);
        }
    }

    let stream = upstream
        .bytes_stream()
        .map(|chunk| chunk.map_err(std::io::Error::other));
    let body = Body::from_stream(stream);

    response_builder
        .body(body)
        .map_err(|_| ProxyError::BuildResponse)
}

pub async fn proxy_post(
    client: &Client,
    url: &str,
    max_body: usize,
    request: Request<Body>,
    apply_headers: impl FnOnce(RequestBuilder, &Parts) -> RequestBuilder,
) -> Result<Response<Body>, ProxyError> {
    let (parts, body) = request.into_parts();
    let body_bytes = to_bytes(body, max_body)
        .await
        .map_err(ProxyError::from_read_body)?;
    let upstream_request = apply_headers(client.post(url).body(body_bytes), &parts);
    let upstream_response = upstream_request.send().await?;
    upstream_to_response(upstream_response).await
}

pub fn forward_content_type(upstream: RequestBuilder, parts: &Parts) -> RequestBuilder {
    match parts.headers.get(header::CONTENT_TYPE) {
        Some(value) => upstream.header(header::CONTENT_TYPE, value),
        None => upstream.header(header::CONTENT_TYPE, "application/json"),
    }
}
