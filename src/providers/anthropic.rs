use axum::{
    body::Body,
    http::{Request, Response},
};
use reqwest::Client;

use super::utils::{forward_content_type, proxy_post};
use crate::proxy::error::ProxyError;

const MESSAGES_URL: &str = "https://api.anthropic.com/v1/messages";
const MAX_BODY_BYTES: usize = 10 * 1024 * 1024;
const API_VERSION: &str = "2023-06-01";

#[derive(Clone, Default)]
pub struct Anthropic;

impl Anthropic {
    pub async fn forward_messages(
        &self,
        client: &Client,
        request: Request<Body>,
    ) -> Result<Response<Body>, ProxyError> {
        proxy_post(
            client,
            MESSAGES_URL,
            MAX_BODY_BYTES,
            request,
            |mut upstream, parts| {
                if let Some(value) = parts.headers.get("x-api-key") {
                    upstream = upstream.header("x-api-key", value);
                }
                upstream = match parts.headers.get("anthropic-version") {
                    Some(value) => upstream.header("anthropic-version", value),
                    None => upstream.header("anthropic-version", API_VERSION),
                };
                forward_content_type(upstream, parts)
            },
        )
        .await
    }
}
