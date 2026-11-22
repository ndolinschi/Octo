use std::pin::Pin;
use std::task::{Context, Poll};
use std::time::Instant;

use axum::{
    body::{to_bytes, Body, Bytes},
    http::{header, request::Parts, HeaderMap, HeaderName, Request, Response},
};
use futures_util::{Stream, StreamExt};
use reqwest::{Client, RequestBuilder};
use tracing::info;

use crate::auto::parent_session_id;
use crate::history::{
    complete_dropped_usage, describe_input, request_payload, resolve_cost, response_payload,
    token_from_headers, usage_from_parts, CallObserve, DroppedStream, FinishedCall, Millis,
};
use crate::proxy::error::ProxyError;

#[derive(Debug, thiserror::Error)]
pub enum ReadCappedError {
    #[error(transparent)]
    Http(#[from] reqwest::Error),
    #[error("upstream response exceeded {0} bytes")]
    TooLarge(usize),
}

pub async fn read_response_bytes_capped(
    mut response: reqwest::Response,
    max_bytes: usize,
) -> Result<Vec<u8>, ReadCappedError> {
    if response
        .content_length()
        .is_some_and(|len| len > max_bytes as u64)
    {
        return Err(ReadCappedError::TooLarge(max_bytes));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        if bytes.len().saturating_add(chunk.len()) > max_bytes {
            return Err(ReadCappedError::TooLarge(max_bytes));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

fn should_forward_response_header(name: &HeaderName) -> bool {
    if name == header::CONTENT_TYPE || name == header::CACHE_CONTROL {
        return true;
    }
    let name = name.as_str();
    name == "x-request-id"
        || name == "x-generation-id"
        || name == "retry-after"
        || name.starts_with("openai-")
        || name.starts_with("x-ratelimit-")
        || name.starts_with("anthropic-ratelimit-")
}

fn generation_id_from_headers(headers: &HeaderMap) -> Option<String> {
    headers
        .get("x-generation-id")
        .or_else(|| headers.get("request-id"))
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| value.starts_with("gen-"))
        .map(str::to_string)
}

async fn upstream_to_response(
    upstream: reqwest::Response,
    capture: Option<Capture>,
) -> Result<Response<Body>, ProxyError> {
    let status = upstream.status();
    info!(
        %status,
        request_bytes = capture.as_ref().map(|c| c.request_bytes).unwrap_or(0),
        "upstream responded"
    );

    let mut response_builder = Response::builder().status(status);
    let header_generation_id = generation_id_from_headers(upstream.headers());

    for (name, value) in upstream.headers() {
        if should_forward_response_header(name) {
            response_builder = response_builder.header(name, value);
        }
    }

    let is_sse = upstream
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| {
            v.trim_start()
                .to_ascii_lowercase()
                .starts_with("text/event-stream")
        });
    let stream = upstream
        .bytes_stream()
        .map(|chunk| chunk.map_err(std::io::Error::other));
    let body = match capture {
        Some(mut capture) => {
            capture.header_generation_id = header_generation_id;
            capture.initial_status = status.as_u16();
            let terminator = if status.is_success() && is_sse {
                Terminator::for_kind(capture.observe.kind)
            } else {
                None
            };
            Body::from_stream(Tee::new(stream, status.as_u16(), capture, terminator))
        }
        None => Body::from_stream(stream),
    };

    response_builder
        .body(body)
        .map_err(|_| ProxyError::BuildResponse)
}

pub async fn proxy_post_bytes(
    client: &Client,
    url: &str,
    parts: Parts,
    body_bytes: Bytes,
    apply_headers: impl FnOnce(RequestBuilder, &Parts) -> RequestBuilder,
    observe: Option<CallObserve>,
) -> Result<Response<Body>, ProxyError> {
    let capture = observe.map(|observe| Capture::from_request(&observe, &parts, &body_bytes));
    let started = Instant::now();
    let upstream_request = apply_headers(client.post(url).body(body_bytes), &parts);
    let upstream_response = match upstream_request.send().await {
        Ok(response) => response,
        Err(err) => {
            if let Some(mut capture) = capture {
                capture.started = started;
                capture.finish(502, Vec::new(), Vec::new(), 0, Completion::Whole);
            }
            return Err(err.into());
        }
    };
    let mut capture = capture;
    if let Some(capture) = capture.as_mut() {
        capture.started = started;
    }
    upstream_to_response(upstream_response, capture).await
}

pub async fn proxy_post(
    client: &Client,
    url: &str,
    max_body: usize,
    request: Request<Body>,
    apply_headers: impl FnOnce(RequestBuilder, &Parts) -> RequestBuilder,
    observe: Option<CallObserve>,
) -> Result<Response<Body>, ProxyError> {
    let (parts, body) = request.into_parts();
    let body_bytes = to_bytes(body, max_body)
        .await
        .map_err(ProxyError::from_read_body)?;
    proxy_post_bytes(client, url, parts, body_bytes, apply_headers, observe).await
}

struct Capture {
    observe: CallObserve,
    token_hash: Option<String>,
    model: Option<String>,
    message: Option<String>,
    input: String,
    request_payload: String,
    request_bytes: usize,
    capture_limit: usize,
    started: Instant,
    header_generation_id: Option<String>,
    initial_status: u16,
}

impl Capture {
    fn from_request(observe: &CallObserve, parts: &Parts, body: &Bytes) -> Self {
        let input = String::from_utf8_lossy(body).into_owned();
        let (model, message) = describe_input(&input);
        let secret = token_from_headers(&parts.headers);
        let token_hash = if secret.is_empty() {
            None
        } else {
            match observe.history.token_hash(&secret) {
                Ok(hash) => Some(hash),
                Err(err) => {
                    tracing::warn!(%err, "history token hash failed");
                    None
                }
            }
        };
        let request_payload = request_payload(observe.kind, observe.provider, &input);
        Self {
            token_hash,
            observe: CallObserve {
                history: observe.history.clone(),
                kind: observe.kind,
                provider: observe.provider,
                rerouting: observe.rerouting,
                rerouting_reason: observe.rerouting_reason.clone(),
                session_id: observe.session_id.clone(),
                tier_before: observe.tier_before.clone(),
                tier_after: observe.tier_after.clone(),
                decided_tier: observe.decided_tier.clone(),
                trigger: observe.trigger.clone(),
                trimmed_from_tokens: observe.trimmed_from_tokens,
                client_model: observe.client_model.clone(),
                client_has_thinking: observe.client_has_thinking,
                client_tool_names: observe.client_tool_names.clone(),
                bg_signal: observe.bg_signal,
                hk_text_signal: observe.hk_text_signal,
                auto: observe.auto.clone(),
                on_response: observe.on_response.clone(),
                request_id: observe.request_id.clone(),
                budget_key: observe.budget_key.clone(),
            },
            model,
            message,
            request_bytes: body.len(),
            request_payload,
            capture_limit: observe.history.capture_limit(),
            input,
            started: Instant::now(),
            header_generation_id: None,
            initial_status: 0,
        }
    }

    fn finish(
        self,
        status: u16,
        output: Vec<u8>,
        tail: Vec<u8>,
        response_bytes: usize,
        completion: Completion,
    ) {
        let stream_failed = completion == Completion::Failed;
        if stream_failed {
            tracing::warn!(
                session_id = self.observe.session_id.as_deref().unwrap_or(""),
                initial_status = self.initial_status,
                "upstream stream failed after client saw success headers"
            );
        }
        let output_text = String::from_utf8_lossy(&output).into_owned();
        let tail_text = String::from_utf8_lossy(&tail);
        let mut usage = usage_from_parts(&output_text, &tail_text, response_bytes);
        if completion != Completion::Whole {
            usage = complete_dropped_usage(
                usage,
                DroppedStream {
                    request_bytes: self.request_bytes,
                    prefix: &output_text,
                    tail: &tail_text,
                    response_bytes,
                },
            );
        }
        let resolved = resolve_cost(
            &usage,
            self.model.as_deref(),
            &self.observe.history.prices(),
        );
        let response_payload = response_payload(
            self.observe.kind,
            self.observe.provider,
            &output_text,
            &tail_text,
            response_bytes,
        );
        let latency_ms = Millis::new(self.started.elapsed().as_millis() as u64);
        let generation_id = self.header_generation_id.or(usage.generation_id.clone());
        let generation_id_for_row = generation_id.clone();
        let estimate_ratio = crate::history::estimate_ratio(&resolved);
        if let Some(ratio) = estimate_ratio {
            crate::history::warn_estimate_ratio(
                self.model.as_deref().unwrap_or(""),
                ratio,
                resolved.price_source,
            );
        }
        let call_model = self.model.clone().unwrap_or_default();
        let parent = self
            .observe
            .session_id
            .as_deref()
            .and_then(parent_session_id)
            .map(str::to_string);
        self.observe.history.record(FinishedCall {
            kind: self.observe.kind,
            provider: self.observe.provider,
            model: self.model,
            token_hash: self.token_hash,
            message: self.message,
            input: self.input,
            output: output_text.clone(),
            request_payload: self.request_payload,
            response_payload,
            status,
            latency_ms,
            request_bytes: self.request_bytes,
            response_bytes,
            input_tokens: usage.input_tokens,
            output_tokens: usage.output_tokens,
            cost: resolved.cost,
            or_cost: resolved.or_cost,
            upstream_cost: resolved.upstream_cost,
            estimated_cost: resolved.estimated_cost,
            cost_source: resolved.source.as_str().to_string(),
            is_byok: resolved.is_byok,
            upstream_provider: resolved.upstream_provider,
            trimmed_from_tokens: self.observe.trimmed_from_tokens,
            cache_read_tokens: usage.cache_read_tokens,
            cache_write_tokens: usage.cache_write_tokens,
            generation_id,
            rerouting: self.observe.rerouting,
            rerouting_reason: self.observe.rerouting_reason.clone(),
            session_id: self.observe.session_id.clone(),
            parent_session_id: parent,
            tier_before: self.observe.tier_before.clone(),
            tier_after: self.observe.tier_after.clone(),
            trigger: self.observe.trigger.clone(),
            client_model: self.observe.client_model.clone(),
            client_has_thinking: self.observe.client_has_thinking,
            client_tool_names: self.observe.client_tool_names.clone(),
            bg_signal: self.observe.bg_signal,
            hk_text_signal: self.observe.hk_text_signal,
            request_id: self.observe.request_id.clone(),
        });
        if let Some(auto) = &self.observe.auto {
            let spent_after = auto.charge(
                &self.observe.history,
                self.observe.session_id.as_deref(),
                self.observe.budget_key.as_deref(),
                resolved.cost.map_or(0, |c| c.0),
            );
            if let Some(request_id) = &self.observe.request_id {
                let row = crate::auto::CallRow {
                    model: call_model,
                    tier: self.observe.tier_after.clone().unwrap_or_default(),
                    decided_tier: self.observe.decided_tier.clone(),
                    trigger: self.observe.trigger.clone(),
                    input_tokens: usage.input_tokens.map_or(0, |t| t.0),
                    output_tokens: usage.output_tokens.map_or(0, |t| t.0),
                    cache_read_tokens: usage.cache_read_tokens.map_or(0, |t| t.0),
                    cache_write_tokens: usage.cache_write_tokens.map_or(0, |t| t.0),
                    cost_usd: resolved.cost.map_or(0.0, |c| c.0 as f64 / 1_000_000.0),
                    cost_source: cost_source_label(resolved.source),
                    estimate_ratio,
                    price_source: resolved.price_source.map(|source| source.label()),
                    upstream_id: generation_id_for_row,
                    spent_after_usd: spent_after.map(crate::auto::micros_usd),
                    route: None,
                };
                auto.record_call_persisted(
                    &self.observe.history,
                    crate::auto::PersistedCall {
                        request_id: request_id.clone(),
                        session_id: self.observe.session_id.clone(),
                        budget_key: self.observe.budget_key.clone(),
                        row,
                    },
                );
            }
        }
        if let Some(hook) = self.observe.on_response {
            let text = if tail_text.is_empty() {
                output_text
            } else {
                format!("{output_text}{tail_text}")
            };
            hook(&text);
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Completion {
    Whole,
    Dropped,
    Failed,
}

const USAGE_TAIL: usize = 64 * 1024;

/// What the end of a complete SSE response looks like, per wire format. A 2xx stream that ends (or breaks) without it
/// was cut off: the client gets the provider's own error event so it can tell a truncated answer from a whole one.
#[derive(Clone, Copy)]
enum Terminator {
    /// Anthropic Messages: the last event is `message_stop` (or an `error` event the upstream sent itself).
    Messages,
    /// OpenAI-style chat: the last data line is `[DONE]` (or an error object the upstream sent itself).
    Chat,
}

/// How far back from the end of the stream the terminator is looked for.
const TERMINATOR_WINDOW: usize = 1024;

const BROKE_OFF: &str =
    "The connection to the model broke off before the response was complete. Try again.";

impl Terminator {
    fn for_kind(kind: crate::history::CallKind) -> Option<Self> {
        match kind {
            crate::history::CallKind::Messages => Some(Self::Messages),
            crate::history::CallKind::Llm => Some(Self::Chat),
            crate::history::CallKind::Decision => None,
        }
    }

    fn is_complete(self, tail: &[u8]) -> bool {
        let recent = String::from_utf8_lossy(&tail[tail.len().saturating_sub(TERMINATOR_WINDOW)..]);
        match self {
            Self::Messages => {
                recent.contains("event: message_stop")
                    || recent.contains("\"type\":\"message_stop\"")
                    || recent.contains("event: error")
            }
            Self::Chat => recent.contains("[DONE]") || recent.contains("\"error\":"),
        }
    }

    /// The error event in the provider's own format, preceded by whatever ends a half-written event.
    fn error_event(self, tail: &[u8]) -> Bytes {
        let message = serde_json::to_string(BROKE_OFF).unwrap_or_else(|_| "\"error\"".into());
        let mut out = String::new();
        if !tail.is_empty() && !tail.ends_with(b"\n\n") && !tail.ends_with(b"\r\n\r\n") {
            out.push_str("\n\n");
        }
        match self {
            Self::Messages => out.push_str(&format!(
                "event: error\ndata: {{\"type\":\"error\",\"error\":{{\"type\":\"api_error\",\"message\":{message}}}}}\n\n"
            )),
            Self::Chat => out.push_str(&format!(
                "data: {{\"error\":{{\"message\":{message},\"type\":\"api_error\"}}}}\n\n"
            )),
        }
        Bytes::from(out)
    }
}

struct Tee<S> {
    inner: S,
    status: u16,
    buf: Vec<u8>,
    tail: Vec<u8>,
    response_bytes: usize,
    capture_limit: usize,
    capture: Option<Capture>,
    stream_failed: bool,
    /// Set for a 2xx SSE response whose end can be checked.
    terminator: Option<Terminator>,
    /// The closing error event was sent: the next poll ends the body without touching `inner`.
    ended: bool,
}

impl<S> Tee<S> {
    fn new(inner: S, status: u16, capture: Capture, terminator: Option<Terminator>) -> Self {
        let capture_limit = capture.capture_limit;
        Self {
            inner,
            status,
            buf: Vec::new(),
            tail: Vec::new(),
            response_bytes: 0,
            capture_limit,
            capture: Some(capture),
            stream_failed: false,
            terminator,
            ended: false,
        }
    }

    /// Records a cut-off SSE call (once): a failed one (502), whatever status the client saw, because the client was
    /// told with an error event.
    fn finish_truncated(&mut self) {
        if let Some(capture) = self.capture.take() {
            capture.finish(
                502,
                std::mem::take(&mut self.buf),
                std::mem::take(&mut self.tail),
                self.response_bytes,
                Completion::Failed,
            );
        }
    }
}

impl<S> Stream for Tee<S>
where
    S: Stream<Item = Result<Bytes, std::io::Error>> + Unpin,
{
    type Item = Result<Bytes, std::io::Error>;

    fn poll_next(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        let this = self.get_mut();
        if this.ended {
            return Poll::Ready(None);
        }
        match Pin::new(&mut this.inner).poll_next(cx) {
            Poll::Ready(Some(Ok(chunk))) => {
                this.response_bytes = this.response_bytes.saturating_add(chunk.len());
                if this.buf.len() < this.capture_limit {
                    let room = this.capture_limit - this.buf.len();
                    let take = room.min(chunk.len());
                    this.buf.extend_from_slice(&chunk[..take]);
                }
                this.tail.extend_from_slice(&chunk);
                if this.tail.len() > USAGE_TAIL {
                    let drop_n = this.tail.len() - USAGE_TAIL;
                    this.tail.drain(..drop_n);
                }
                Poll::Ready(Some(Ok(chunk)))
            }
            Poll::Ready(Some(Err(err))) => {
                if this.status >= 200 && this.status < 300 {
                    this.stream_failed = true;
                    if let Some(t) = this.terminator {
                        // Tell the client in its own format, then close cleanly instead of aborting the connection.
                        tracing::warn!(%err, "upstream stream broke off; sending an error event");
                        let event = t.error_event(&this.tail);
                        this.ended = true;
                        this.finish_truncated();
                        return Poll::Ready(Some(Ok(event)));
                    }
                } else {
                    this.status = 502;
                }
                Poll::Ready(Some(Err(err)))
            }
            Poll::Ready(None) => {
                if let Some(t) = this.terminator {
                    if !this.stream_failed && !t.is_complete(&this.tail) {
                        tracing::warn!(
                            "upstream stream ended without its terminator; sending an error event"
                        );
                        this.stream_failed = true;
                        let event = t.error_event(&this.tail);
                        this.ended = true;
                        this.finish_truncated();
                        return Poll::Ready(Some(Ok(event)));
                    }
                }
                if let Some(capture) = this.capture.take() {
                    capture.finish(
                        this.status,
                        std::mem::take(&mut this.buf),
                        std::mem::take(&mut this.tail),
                        this.response_bytes,
                        if this.stream_failed {
                            Completion::Failed
                        } else {
                            Completion::Whole
                        },
                    );
                }
                Poll::Ready(None)
            }
            Poll::Pending => Poll::Pending,
        }
    }
}

impl<S> Drop for Tee<S> {
    fn drop(&mut self) {
        if let Some(capture) = self.capture.take() {
            capture.finish(
                self.status,
                std::mem::take(&mut self.buf),
                std::mem::take(&mut self.tail),
                self.response_bytes,
                if self.stream_failed {
                    Completion::Failed
                } else {
                    Completion::Dropped
                },
            );
        }
    }
}

pub fn forward_content_type(upstream: RequestBuilder, parts: &Parts) -> RequestBuilder {
    match parts.headers.get(header::CONTENT_TYPE) {
        Some(value) => upstream.header(header::CONTENT_TYPE, value),
        None => upstream.header(header::CONTENT_TYPE, "application/json"),
    }
}

fn bearer_token_from_parts(parts: &Parts) -> Option<String> {
    let value = parts.headers.get(header::AUTHORIZATION)?.to_str().ok()?;
    let token = value
        .strip_prefix("Bearer ")
        .or_else(|| value.strip_prefix("bearer "))
        .unwrap_or(value);
    if token.is_empty() {
        None
    } else {
        Some(token.to_string())
    }
}

/// Claude Code sends `Authorization: Bearer` via `ANTHROPIC_AUTH_TOKEN`; Anthropic expects `x-api-key`.
pub fn apply_anthropic_messages_auth(
    mut upstream: RequestBuilder,
    parts: &Parts,
) -> RequestBuilder {
    if let Some(value) = parts.headers.get("x-api-key") {
        return upstream.header("x-api-key", value);
    }
    if let Some(token) = bearer_token_from_parts(parts) {
        upstream = upstream.header("x-api-key", token);
    }
    upstream
}

pub fn apply_openrouter_messages_auth(
    mut upstream: RequestBuilder,
    parts: &Parts,
) -> RequestBuilder {
    if let Some(value) = parts.headers.get(header::AUTHORIZATION) {
        return upstream.header(header::AUTHORIZATION, value);
    }
    if let Some(value) = parts.headers.get("x-api-key") {
        if let Ok(token) = value.to_str() {
            upstream = upstream.header(header::AUTHORIZATION, format!("Bearer {token}"));
        }
    } else if let Some(token) = bearer_token_from_parts(parts) {
        upstream = upstream.header(header::AUTHORIZATION, format!("Bearer {token}"));
    }
    upstream
}

pub fn apply_openai_request_headers(mut upstream: RequestBuilder, parts: &Parts) -> RequestBuilder {
    if let Some(value) = parts.headers.get(header::AUTHORIZATION) {
        upstream = upstream.header(header::AUTHORIZATION, value);
    }
    for (name, value) in parts.headers.iter() {
        if name.as_str().starts_with("openai-") {
            upstream = upstream.header(name, value);
        }
    }
    forward_content_type(upstream, parts)
}

pub fn cost_source_label(source: crate::history::CostSource) -> &'static str {
    match source {
        crate::history::CostSource::Upstream | crate::history::CostSource::OpenRouter => "reported",
        crate::history::CostSource::Estimate | crate::history::CostSource::None => "estimated",
    }
}
