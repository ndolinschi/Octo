use axum::{
    body::Body,
    http::{header, Request, Response},
};
use reqwest::Client;

use super::{apply_attribution, AttributionDefaults};
use crate::providers::utils::{forward_content_type, proxy_post};
use crate::proxy::error::ProxyError;

pub async fn authorized_attributed_post(
    client: &Client,
    url: &str,
    max_body_bytes: usize,
    openrouter: &AttributionDefaults,
    request: Request<Body>,
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
    )
    .await
}
