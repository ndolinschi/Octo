use axum::{
    body::{Body, Bytes},
    http::{request::Parts, Response},
};
use reqwest::Client;

use super::traits::ChatCompletions;
use crate::providers::openrouter::{self, AttributionDefaults};
use crate::proxy::error::ProxyError;

#[derive(Clone)]
pub struct OpenRouter {
    chat_completions_url: String,
    openrouter: AttributionDefaults,
}

impl OpenRouter {
    pub fn new(
        chat_completions_url: String,
        default_http_referer: Option<String>,
        default_openrouter_title: Option<String>,
    ) -> Self {
        Self {
            chat_completions_url,
            openrouter: AttributionDefaults::new(default_http_referer, default_openrouter_title),
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
        observe: Option<crate::history::CallObserve>,
    ) -> Result<Response<Body>, ProxyError> {
        let openrouter = self.openrouter.clone();
        let url = self.chat_completions_url.clone();
        openrouter::authorized_attributed_post_bytes(
            client,
            &url,
            parts,
            body_bytes,
            &openrouter,
            observe,
        )
        .await
    }
}

impl ChatCompletions for OpenRouter {
    fn upstream_url(&self) -> &str {
        self.chat_completions_url()
    }
}
