use axum::{
    body::Body,
    http::{header, Request, Response},
};
use reqwest::Client;

use super::utils::{forward_content_type, proxy_post};
use crate::proxy::error::ProxyError;

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
            forward_content_type(upstream, parts)
        })
        .await
    }
}

#[derive(Clone, Default)]
pub struct OpenAi;

impl OpenAICompatible for OpenAi {
    fn chat_completions_url(&self) -> &'static str {
        "https://api.openai.com/v1/chat/completions"
    }

    fn max_body_bytes(&self) -> usize {
        10 * 1024 * 1024
    }
}
