use axum::{
    body::Body,
    http::{Request, Response},
};
use reqwest::Client;

use super::utils::{forward_content_type, proxy_post, MAX_BODY_BYTES};
use crate::proxy::error::ProxyError;

const DEFAULT_MESSAGES_URL: &str = "https://api.anthropic.com/v1/messages";
const API_VERSION: &str = "2023-06-01";

#[derive(Clone)]
pub struct Anthropic {
    messages_url: String,
}

impl Default for Anthropic {
    fn default() -> Self {
        Self {
            messages_url: DEFAULT_MESSAGES_URL.to_string(),
        }
    }
}

impl Anthropic {
    pub fn with_messages_url(url: impl Into<String>) -> Self {
        Self {
            messages_url: url.into(),
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
            MAX_BODY_BYTES,
            request,
            |mut upstream, parts| {
                if let Some(value) = parts.headers.get("x-api-key") {
                    upstream = upstream.header("x-api-key", value);
                }
                upstream = match parts.headers.get("anthropic-version") {
                    Some(value) => upstream.header("anthropic-version", value),
                    None => upstream.header("anthropic-version", API_VERSION),
                };
                forward_content_type(upstream, parts)
            },
        )
        .await
    }
}
