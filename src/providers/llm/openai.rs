use axum::{
    body::Body,
    http::{header, Request, Response},
};
use reqwest::Client;

use super::traits::ChatCompletions;
use crate::providers::utils::{forward_content_type, proxy_post};
use crate::proxy::error::ProxyError;

#[derive(Clone)]
pub struct OpenAI {
    chat_completions_url: String,
    max_body_bytes: usize,
}

impl OpenAI {
    pub fn new(chat_completions_url: String, max_body_bytes: usize) -> Self {
        Self {
            chat_completions_url,
            max_body_bytes,
        }
    }

    pub fn chat_completions_url(&self) -> &str {
        &self.chat_completions_url
    }
}

impl ChatCompletions for OpenAI {
    fn upstream_url(&self) -> &str {
        self.chat_completions_url()
    }

    fn forward_chat_completions(
        &self,
        client: &Client,
        request: Request<Body>,
    ) -> impl std::future::Future<Output = Result<Response<Body>, ProxyError>> + Send {
        let url = self.chat_completions_url.clone();
        let max_body_bytes = self.max_body_bytes;
        async move {
            proxy_post(
                client,
                &url,
                max_body_bytes,
                request,
                move |mut upstream, parts| {
                    if let Some(value) = parts.headers.get(header::AUTHORIZATION) {
                        upstream = upstream.header(header::AUTHORIZATION, value);
                    }
                    forward_content_type(upstream, parts)
                },
            )
            .await
        }
    }
}
