use axum::{
    body::Body,
    http::{header, Request, Response},
};
use reqwest::Client;

use super::traits::Decisions;
use crate::providers::openrouter::{self, AttributionDefaults};
use crate::providers::utils::{forward_content_type, proxy_post};
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

    pub fn decisions_url(&self) -> &str {
        &self.decisions_url
    }
}

impl Decisions for OpenRouter {
    fn upstream_url(&self) -> &str {
        self.decisions_url()
    }

    fn forward_decisions(
        &self,
        client: &Client,
        request: Request<Body>,
    ) -> impl std::future::Future<Output = Result<Response<Body>, ProxyError>> + Send {
        let openrouter = self.openrouter.clone();
        let url = self.decisions_url.clone();
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
                    upstream = openrouter::apply_attribution(upstream, parts, &openrouter);
                    forward_content_type(upstream, parts)
                },
            )
            .await
        }
    }
}
