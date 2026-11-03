use axum::{
    body::Body,
    http::{Request, Response},
};
use reqwest::Client;

use super::utils::{forward_content_type, proxy_post};
use crate::proxy::error::ProxyError;

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
            forward_content_type(upstream, parts)
        })
        .await
    }
}

#[derive(Clone, Default)]
pub struct Anthropic;

impl AnthropicCompatible for Anthropic {
    fn messages_url(&self) -> &'static str {
        "https://api.anthropic.com/v1/messages"
    }

    fn max_body_bytes(&self) -> usize {
        10 * 1024 * 1024
    }

    fn api_version(&self) -> &'static str {
        "2023-06-01"
    }
}
