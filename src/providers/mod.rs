mod openai;

use axum::{
    body::{to_bytes, Body},
    http::{header, Request, Response},
};
use futures_util::StreamExt;
use reqwest::Client;
use tracing::info;

pub use openai::OpenAi;

use crate::proxy::error::ProxyError;

pub trait OpenAICompatible: Send + Sync + Clone {
    fn chat_completions_url(&self) -> &'static str;
    fn max_body_bytes(&self) -> usize;

    async fn forward_chat_completions(
        &self,
        client: &Client,
        request: Request<Body>,
    ) -> Result<Response<Body>, ProxyError> {
        let max_body = self.max_body_bytes();
        let upstream_url = self.chat_completions_url();

        let (parts, body) = request.into_parts();
        let body_bytes = to_bytes(body, max_body)
            .await
            .map_err(ProxyError::ReadBody)?;
        let mut upstream = client.post(upstream_url).body(body_bytes);

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
}
