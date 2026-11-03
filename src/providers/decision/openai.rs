use axum::{
    body::Body,
    http::{header, Request, Response},
};
use reqwest::Client;

use crate::providers::utils::{forward_content_type, proxy_post};
use crate::proxy::error::ProxyError;

#[derive(Clone)]
#[allow(dead_code)]
pub struct OpenAi {
    decisions_url: String,
    max_body_bytes: usize,
}

#[allow(dead_code)]
impl OpenAi {
    pub fn new(decisions_url: String, max_body_bytes: usize) -> Self {
        Self {
            decisions_url,
            max_body_bytes,
        }
    }

    pub fn decisions_url(&self) -> &str {
        &self.decisions_url
    }

    pub async fn forward_decisions(
        &self,
        client: &Client,
        request: Request<Body>,
    ) -> Result<Response<Body>, ProxyError> {
        proxy_post(
            client,
            self.decisions_url(),
            self.max_body_bytes,
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
