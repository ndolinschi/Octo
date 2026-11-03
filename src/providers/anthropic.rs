use axum::{
    body::Body,
    http::{Request, Response},
};
use reqwest::Client;

use super::utils::{forward_content_type, proxy_post};
use crate::proxy::error::ProxyError;

#[derive(Clone)]
pub struct Anthropic {
    messages_url: String,
    default_api_version: String,
    max_body_bytes: usize,
}

impl Anthropic {
    pub fn new(messages_url: String, default_api_version: String, max_body_bytes: usize) -> Self {
        Self {
            messages_url,
            default_api_version,
            max_body_bytes,
        }
    }

    pub fn messages_url(&self) -> &str {
        &self.messages_url
    }

    pub async fn forward_messages(
        &self,
        client: &Client,
        request: Request<Body>,
    ) -> Result<Response<Body>, ProxyError> {
        proxy_post(
            client,
            self.messages_url(),
            self.max_body_bytes,
            request,
            |mut upstream, parts| {
                if let Some(value) = parts.headers.get("x-api-key") {
                    upstream = upstream.header("x-api-key", value);
                }
                upstream = match parts.headers.get("anthropic-version") {
                    Some(value) => upstream.header("anthropic-version", value),
                    None => upstream.header("anthropic-version", &self.default_api_version),
                };
                forward_content_type(upstream, parts)
            },
        )
        .await
    }
}
