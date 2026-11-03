use axum::{
    body::Body,
    http::{Request, Response},
};
use reqwest::Client;

use crate::providers::openrouter::{self, AttributionDefaults};
use crate::proxy::error::ProxyError;

#[derive(Clone)]
pub struct OpenRouter {
    decisions_url: String,
    openrouter: AttributionDefaults,
    max_body_bytes: usize,
}

impl OpenRouter {
    pub fn new(
        decisions_url: String,
        default_http_referer: Option<String>,
        default_openrouter_title: Option<String>,
        max_body_bytes: usize,
    ) -> Self {
        Self {
            decisions_url,
            openrouter: AttributionDefaults::new(default_http_referer, default_openrouter_title),
            max_body_bytes,
        }
    }

    pub fn upstream_url(&self) -> &str {
        &self.decisions_url
    }

    pub async fn forward_decisions(
        &self,
        client: &Client,
        request: Request<Body>,
    ) -> Result<Response<Body>, ProxyError> {
        let openrouter = self.openrouter.clone();
        let url = self.decisions_url.clone();
        let max_body_bytes = self.max_body_bytes;
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
