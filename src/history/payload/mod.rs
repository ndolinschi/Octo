mod claude;
mod common;
mod decision;
mod envelope;
mod openai_chat;

use axum::http::HeaderMap;

use super::call_kind::CallKind;
use super::call_provider::CallProvider;

#[derive(Clone)]
pub struct ParsedUsage {
    pub input_tokens: Option<super::TokenCount>,
    pub output_tokens: Option<super::TokenCount>,
    pub cost: Option<super::CostMicros>,
    pub cache_read_tokens: Option<super::TokenCount>,
    pub cache_write_tokens: Option<super::TokenCount>,
    pub generation_id: Option<String>,
}

impl ParsedUsage {
    pub(crate) const EMPTY: Self = Self {
        input_tokens: None,
        output_tokens: None,
        cost: None,
        cache_read_tokens: None,
        cache_write_tokens: None,
        generation_id: None,
    };
}

pub fn token_from_headers(headers: &HeaderMap) -> String {
    if let Some(value) = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
    {
        let secret = value
            .strip_prefix("Bearer ")
            .or_else(|| value.strip_prefix("bearer "))
            .unwrap_or(value);
        if !secret.is_empty() {
            return secret.to_string();
        }
    }
    if let Some(value) = headers.get("x-api-key").and_then(|v| v.to_str().ok()) {
        if !value.is_empty() {
            return value.to_string();
        }
    }
    String::new()
}

pub fn is_subagent(body: &serde_json::Value) -> bool {
    claude::is_subagent(body)
}

pub fn describe_input(body: &str) -> (Option<String>, Option<String>) {
    common::describe_input(body)
}

pub fn usage_from_output(output: &str) -> ParsedUsage {
    common::usage_from_output(output)
}

pub fn usage_from_parts(prefix: &str, tail: &str, response_bytes: usize) -> ParsedUsage {
    common::usage_from_parts(prefix, tail, response_bytes)
}

pub fn cost_micros_from_json(value: &serde_json::Value) -> Option<super::CostMicros> {
    common::cost_micros_from_json(value)
}

pub fn request_payload(kind: CallKind, provider: CallProvider, body: &str) -> String {
    let inner = match (kind, provider) {
        (CallKind::Decision, CallProvider::OpenRouter) => decision::request(body),
        (CallKind::Messages, _) | (_, CallProvider::Claude) => claude::request(body),
        (_, CallProvider::OpenAi | CallProvider::OpenRouter) => openai_chat::request(body),
    };
    envelope::tagged_string(provider, inner)
}

pub fn response_payload(
    kind: CallKind,
    provider: CallProvider,
    prefix: &str,
    tail: &str,
    response_bytes: usize,
) -> String {
    let inner = match (kind, provider) {
        (CallKind::Decision, CallProvider::OpenRouter) => {
            decision::response(prefix, tail, response_bytes)
        }
        (CallKind::Messages, _) | (_, CallProvider::Claude) => {
            claude::response(prefix, tail, response_bytes)
        }
        (_, CallProvider::OpenAi | CallProvider::OpenRouter) => {
            openai_chat::response(prefix, tail, response_bytes)
        }
    };
    envelope::tagged_string(provider, inner)
}
