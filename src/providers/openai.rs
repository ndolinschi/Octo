use axum::{
    body::Body,
    http::{header, Request, Response},
};
use reqwest::Client;

use super::openrouter::{self, AttributionDefaults};
use super::utils::{forward_content_type, proxy_post};
use crate::proxy::error::ProxyError;

#[derive(Clone)]
pub struct OpenAi {
    chat_completions_url: String,
    openrouter: AttributionDefaults,
    max_body_bytes: usize,
}

impl OpenAi {
    pub fn new(
        chat_completions_url: String,
        default_http_referer: Option<String>,
        default_openrouter_title: Option<String>,
        max_body_bytes: usize,
    ) -> Self {
        Self {
            chat_completions_url,
            openrouter: AttributionDefaults::new(default_http_referer, default_openrouter_title),
            max_body_bytes,
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
        let openrouter = self.openrouter.clone();
        proxy_post(
            client,
            self.chat_completions_url(),
            self.max_body_bytes,
            request,
            move |mut upstream, parts| {
                if let Some(value) = parts.headers.get(header::AUTHORIZATION) {
                    upstream = upstream.header(header::AUTHORIZATION, value);
                }
                upstream = openrouter::apply_attribution(upstream, parts, &openrouter);
                forward_content_type(upstream, parts)
            },
        )
        .await
    }
}
