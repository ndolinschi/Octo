use axum::{
    body::{Body, Bytes},
    http::{header, request::Parts, Request, Response},
};
use reqwest::Client;

use super::{apply_attribution, AttributionDefaults};
use crate::history::CallObserve;
use crate::providers::utils::{forward_content_type, proxy_post, proxy_post_bytes};
use crate::proxy::error::ProxyError;

pub async fn authorized_attributed_post(
    client: &Client,
    url: &str,
    max_body_bytes: usize,
    openrouter: &AttributionDefaults,
    request: Request<Body>,
    observe: Option<CallObserve>,
) -> Result<Response<Body>, ProxyError> {
    let openrouter = openrouter.clone();
    proxy_post(
        client,
        url,
        max_body_bytes,
        request,
        move |mut upstream, parts| {
            if let Some(value) = parts.headers.get(header::AUTHORIZATION) {
                upstream = upstream.header(header::AUTHORIZATION, value);
            }
            upstream = apply_attribution(upstream, parts, &openrouter);
            forward_content_type(upstream, parts)
        },
        observe,
    )
    .await
}

pub async fn authorized_attributed_post_bytes(
    client: &Client,
    url: &str,
    parts: Parts,
    body_bytes: Bytes,
    openrouter: &AttributionDefaults,
    observe: Option<CallObserve>,
) -> Result<Response<Body>, ProxyError> {
    let openrouter = openrouter.clone();
    proxy_post_bytes(
        client,
        url,
        parts,
        body_bytes,
        move |mut upstream, parts| {
            if let Some(value) = parts.headers.get(header::AUTHORIZATION) {
                upstream = upstream.header(header::AUTHORIZATION, value);
            }
            upstream = apply_attribution(upstream, parts, &openrouter);
            forward_content_type(upstream, parts)
        },
        observe,
    )
    .await
}
