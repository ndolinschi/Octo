use axum::{
    body::Body,
    http::{header, request::Parts, HeaderValue, Request, Response},
};
use reqwest::{Client, RequestBuilder};

use super::utils::{forward_content_type, proxy_post};
use crate::proxy::error::ProxyError;

#[derive(Clone)]
pub struct OpenAi {
    chat_completions_url: String,
    default_http_referer: Option<String>,
    default_openrouter_title: Option<String>,
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
            default_http_referer,
            default_openrouter_title,
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
        let default_http_referer = self.default_http_referer.clone();
        let default_openrouter_title = self.default_openrouter_title.clone();
        proxy_post(
            client,
            self.chat_completions_url(),
            self.max_body_bytes,
            request,
            move |mut upstream, parts| {
                if let Some(value) = parts.headers.get(header::AUTHORIZATION) {
                    upstream = upstream.header(header::AUTHORIZATION, value);
                }
                upstream = apply_openrouter_attribution(
                    upstream,
                    parts,
                    default_http_referer.as_deref(),
                    default_openrouter_title.as_deref(),
                );
                forward_content_type(upstream, parts)
            },
        )
        .await
    }
}

fn apply_openrouter_attribution(
    mut upstream: RequestBuilder,
    parts: &Parts,
    default_http_referer: Option<&str>,
    default_openrouter_title: Option<&str>,
) -> RequestBuilder {
    upstream = forward_or_default_header(upstream, parts, header::REFERER, default_http_referer);
    upstream = forward_or_default_header(
        upstream,
        parts,
        "x-openrouter-title",
        default_openrouter_title,
    );
    if let Some(value) = parts.headers.get("x-title") {
        upstream = upstream.header("x-title", value);
    }
    upstream
}

fn forward_or_default_header(
    mut upstream: RequestBuilder,
    parts: &Parts,
    name: impl AsRef<str>,
    default: Option<&str>,
) -> RequestBuilder {
    let name = name.as_ref();
    if let Some(value) = resolve_outbound_header(parts, name, default) {
        upstream = upstream.header(name, value);
    }
    upstream
}

/// Picks an outbound header from the client request, or from config when absent.
pub fn resolve_outbound_header(
    parts: &Parts,
    name: &str,
    default: Option<&str>,
) -> Option<HeaderValue> {
    if let Some(value) = parts.headers.get(name) {
        return Some(value.clone());
    }
    default.and_then(|value| HeaderValue::from_str(value).ok())
}
