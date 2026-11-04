use axum::{
    body::{Body, Bytes},
    http::{header, request::Parts, Request, Response},
};
use reqwest::Client;

use crate::providers::openrouter::{self, apply_attribution, AttributionDefaults};
use crate::providers::utils::{apply_openrouter_messages_auth, forward_content_type, proxy_post};
use crate::proxy::error::ProxyError;

#[derive(Clone)]
pub struct OpenRouter {
    chat_completions_url: String,
    messages_url: String,
    default_api_version: String,
    max_body_bytes: usize,
    openrouter: AttributionDefaults,
}

impl OpenRouter {
    pub fn new(
        chat_completions_url: String,
        messages_url: String,
        default_api_version: String,
        max_body_bytes: usize,
        default_http_referer: Option<String>,
        default_openrouter_title: Option<String>,
    ) -> Self {
        Self {
            chat_completions_url,
            messages_url,
            default_api_version,
            max_body_bytes,
            openrouter: AttributionDefaults::new(default_http_referer, default_openrouter_title),
        }
    }

    pub fn chat_completions_url(&self) -> &str {
        &self.chat_completions_url
    }

    pub fn messages_url(&self) -> &str {
        &self.messages_url
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

    pub async fn forward_messages(
        &self,
        client: &Client,
        request: Request<Body>,
        observe: Option<crate::history::CallObserve>,
    ) -> Result<Response<Body>, ProxyError> {
        let openrouter = self.openrouter.clone();
        let url = self.messages_url.clone();
        let default_api_version = self.default_api_version.clone();
        let max_body_bytes = self.max_body_bytes;
        proxy_post(
            client,
            &url,
            max_body_bytes,
            request,
            move |mut upstream, parts| {
                upstream = apply_openrouter_messages_auth(upstream, parts);
                upstream = apply_attribution(upstream, parts, &openrouter);
                upstream = match parts.headers.get("anthropic-version") {
                    Some(value) => upstream.header("anthropic-version", value),
                    None => upstream.header("anthropic-version", &default_api_version),
                };
                forward_content_type(upstream, parts)
            },
            observe,
        )
        .await
    }
}
