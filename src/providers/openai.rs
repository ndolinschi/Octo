use axum::{
    body::Body,
    http::{header, Request, Response},
};
use reqwest::Client;

use super::utils::{forward_content_type, proxy_post};
use crate::proxy::error::ProxyError;

const CHAT_COMPLETIONS_URL: &str = "https://api.openai.com/v1/chat/completions";
const MAX_BODY_BYTES: usize = 10 * 1024 * 1024;

#[derive(Clone, Default)]
pub struct OpenAi;

impl OpenAi {
    pub async fn forward_chat_completions(
        &self,
        client: &Client,
        request: Request<Body>,
    ) -> Result<Response<Body>, ProxyError> {
        proxy_post(
            client,
            CHAT_COMPLETIONS_URL,
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
