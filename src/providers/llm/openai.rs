use axum::{
    body::{Body, Bytes},
    http::{request::Parts, Response},
};
use reqwest::Client;

use super::traits::ChatCompletions;
use crate::providers::utils::{apply_openai_request_headers, proxy_post_bytes};
use crate::proxy::error::ProxyError;

#[derive(Clone)]
pub struct OpenAI {
    chat_completions_url: String,
}

impl OpenAI {
    pub fn new(chat_completions_url: String) -> Self {
        Self {
            chat_completions_url,
        }
    }

    pub fn chat_completions_url(&self) -> &str {
        &self.chat_completions_url
    }

    pub async fn forward_chat_buffered(
        &self,
        client: &Client,
        parts: Parts,
        body_bytes: Bytes,
    ) -> Result<Response<Body>, ProxyError> {
        let url = self.chat_completions_url.clone();
        proxy_post_bytes(
            client,
            &url,
            parts,
            body_bytes,
            apply_openai_request_headers,
        )
        .await
    }
}

impl ChatCompletions for OpenAI {
    fn upstream_url(&self) -> &str {
        self.chat_completions_url()
    }
}
