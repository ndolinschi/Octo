use axum::{
    body::Body,
    http::{Request, Response},
};
use reqwest::Client;

use super::traits::ChatCompletions;
use crate::providers::openrouter::{self, AttributionDefaults};
use crate::proxy::error::ProxyError;

#[derive(Clone)]
pub struct OpenAI {
    chat_completions_url: String,
    openrouter: AttributionDefaults,
    max_body_bytes: usize,
}

impl OpenAI {
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
        let openrouter = self.openrouter.clone();
        let url = self.chat_completions_url.clone();
        let max_body_bytes = self.max_body_bytes;
        async move {
            openrouter::authorized_attributed_post(
                client,
                &url,
                max_body_bytes,
                &openrouter,
                request,
            )
            .await
        }
    }
}
