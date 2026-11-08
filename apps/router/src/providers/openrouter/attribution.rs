use axum::http::{header, request::Parts, HeaderValue};
use reqwest::RequestBuilder;

#[derive(Clone)]
pub struct AttributionDefaults {
    pub http_referer: Option<String>,
    pub title: Option<String>,
}

impl AttributionDefaults {
    pub fn new(http_referer: Option<String>, title: Option<String>) -> Self {
        Self {
            http_referer,
            title,
        }
    }
}

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

pub fn apply_attribution(
    mut upstream: RequestBuilder,
    parts: &Parts,
    defaults: &AttributionDefaults,
) -> RequestBuilder {
    upstream = forward_or_default_header(
        upstream,
        parts,
        header::REFERER,
        defaults.http_referer.as_deref(),
    );
    upstream = forward_or_default_header(
        upstream,
        parts,
        "x-openrouter-title",
        defaults.title.as_deref(),
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
