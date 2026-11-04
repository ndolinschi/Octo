use axum::{
    body::Body,
    http::{Request, Response},
};
use reqwest::Client;

use crate::history::CallObserve;
use crate::providers::utils::{forward_content_type, proxy_post};
use crate::proxy::error::ProxyError;

#[derive(Clone)]
pub struct Claude {
    messages_url: String,
    default_api_version: String,
    max_body_bytes: usize,
}

impl Claude {
    pub fn new(messages_url: String, default_api_version: String, max_body_bytes: usize) -> Self {
        Self {
            messages_url,
            default_api_version,
            max_body_bytes,
        }
    }

    pub fn messages_url(&self) -> &str {
        &self.messages_url
    }

    pub async fn forward_messages(
        &self,
        client: &Client,
        request: Request<Body>,
        observe: Option<CallObserve>,
    ) -> Result<Response<Body>, ProxyError> {
        let default_api_version = self.default_api_version.clone();
        let url = self.messages_url.clone();
        let max_body_bytes = self.max_body_bytes;
        proxy_post(
            client,
            &url,
            max_body_bytes,
            request,
            move |mut upstream, parts| {
                if let Some(value) = parts.headers.get("x-api-key") {
                    upstream = upstream.header("x-api-key", value);
                }
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
