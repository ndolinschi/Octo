mod anthropic;
mod openai;

use axum::{
    body::{to_bytes, Body},
    http::{header, request::Parts, Request, Response},
};
use futures_util::StreamExt;
use reqwest::{Client, RequestBuilder};
use tracing::info;

pub use anthropic::Anthropic;
pub use openai::OpenAi;

use crate::proxy::error::ProxyError;

async fn upstream_to_response(upstream: reqwest::Response) -> Result<Response<Body>, ProxyError> {
    let status = upstream.status();
    info!(%status, "upstream responded");

    let mut response_builder = Response::builder().status(status);

    if let Some(content_type) = upstream.headers().get(header::CONTENT_TYPE) {
        response_builder = response_builder.header(header::CONTENT_TYPE, content_type);
    }

    if let Some(cache_control) = upstream.headers().get(header::CACHE_CONTROL) {
        response_builder = response_builder.header(header::CACHE_CONTROL, cache_control);
    }

    let stream = upstream
        .bytes_stream()
        .map(|chunk| chunk.map_err(std::io::Error::other));
    let body = Body::from_stream(stream);

    response_builder
        .body(body)
        .map_err(|_| ProxyError::BuildResponse)
}

async fn proxy_post(
    client: &Client,
    url: &str,
    max_body: usize,
    request: Request<Body>,
    apply_headers: impl FnOnce(RequestBuilder, &Parts) -> RequestBuilder,
) -> Result<Response<Body>, ProxyError> {
    let (parts, body) = request.into_parts();
    let body_bytes = to_bytes(body, max_body)
        .await
        .map_err(ProxyError::ReadBody)?;
    let upstream_request = apply_headers(client.post(url).body(body_bytes), &parts);
    let upstream_response = upstream_request.send().await?;
    upstream_to_response(upstream_response).await
}

pub trait OpenAICompatible: Send + Sync + Clone {
    fn chat_completions_url(&self) -> &'static str;
    fn max_body_bytes(&self) -> usize;

    async fn forward_chat_completions(
        &self,
        client: &Client,
        request: Request<Body>,
    ) -> Result<Response<Body>, ProxyError> {
        let url = self.chat_completions_url();
        let max_body = self.max_body_bytes();
        proxy_post(client, url, max_body, request, |mut upstream, parts| {
            if let Some(value) = parts.headers.get(header::AUTHORIZATION) {
                upstream = upstream.header(header::AUTHORIZATION, value);
            }
            match parts.headers.get(header::CONTENT_TYPE) {
                Some(value) => upstream.header(header::CONTENT_TYPE, value),
                None => upstream.header(header::CONTENT_TYPE, "application/json"),
            }
        })
        .await
    }
}

pub trait AnthropicCompatible: Send + Sync + Clone {
    fn messages_url(&self) -> &'static str;
    fn max_body_bytes(&self) -> usize;
    fn api_version(&self) -> &'static str;

    async fn forward_messages(
        &self,
        client: &Client,
        request: Request<Body>,
    ) -> Result<Response<Body>, ProxyError> {
        let url = self.messages_url();
        let max_body = self.max_body_bytes();
        let default_version = self.api_version();
        proxy_post(client, url, max_body, request, |mut upstream, parts| {
            if let Some(value) = parts.headers.get("x-api-key") {
                upstream = upstream.header("x-api-key", value);
            }
            upstream = match parts.headers.get("anthropic-version") {
                Some(value) => upstream.header("anthropic-version", value),
                None => upstream.header("anthropic-version", default_version),
            };
            match parts.headers.get(header::CONTENT_TYPE) {
                Some(value) => upstream.header(header::CONTENT_TYPE, value),
                None => upstream.header(header::CONTENT_TYPE, "application/json"),
            }
        })
        .await
    }
}
