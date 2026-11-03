use axum::{
    body::Body,
    http::{header, Request, Response},
};
use reqwest::Client;

use super::utils::{forward_content_type, proxy_post, MAX_BODY_BYTES};
use crate::proxy::error::ProxyError;

const DEFAULT_CHAT_COMPLETIONS_URL: &str = "https://api.openai.com/v1/chat/completions";

#[derive(Clone)]
pub struct OpenAi {
    chat_completions_url: String,
}

impl Default for OpenAi {
    fn default() -> Self {
        Self {
            chat_completions_url: DEFAULT_CHAT_COMPLETIONS_URL.to_string(),
        }
    }
}

impl OpenAi {
    pub fn with_chat_completions_url(url: impl Into<String>) -> Self {
        Self {
            chat_completions_url: url.into(),
        }
    }

    pub fn chat_completions_url(&self) -> &str {
        &self.chat_completions_url
    }

    pub async fn forward_chat_completions(
        &self,
        client: &Client,
        request: Request<Body>,
    ) -> Result<Response<Body>, ProxyError> {
        proxy_post(
            client,
            self.chat_completions_url(),
            MAX_BODY_BYTES,
            request,
            |mut upstream, parts| {
                if let Some(value) = parts.headers.get(header::AUTHORIZATION) {
                    upstream = upstream.header(header::AUTHORIZATION, value);
                }
                forward_content_type(upstream, parts)
            },
        )
        .await
    }
}
