use std::time::Instant;

use axum::{
    body::{Body, Bytes},
    http::{header, request::Parts, Response, StatusCode},
};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::auto::{parent_session_id, CallRow, PersistedCall};
use crate::history::{
    describe_input, request_payload, response_payload, token_from_headers, CallObserve, CostMicros,
    FinishedCall, Millis, TokenCount,
};
use crate::proxy::error::ProxyError;

#[derive(Clone)]
pub struct Ollama {
    base_url: String,
    max_body_bytes: usize,
}

#[derive(Serialize)]
struct OllamaGenerateRequest<'a> {
    model: &'a str,
    prompt: &'a str,
    #[serde(skip_serializing_if = "str::is_empty")]
    suffix: &'a str,
    stream: bool,
    options: Value,
}

#[derive(Deserialize)]
struct OllamaGenerateResponse {
    #[serde(default)]
    response: String,
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    prompt_eval_count: Option<u64>,
    #[serde(default)]
    eval_count: Option<u64>,
}

impl Ollama {
    pub fn new(base_url: String, max_body_bytes: usize) -> Self {
        Self {
            base_url,
            max_body_bytes,
        }
    }

    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    pub async fn forward_messages(
        &self,
        client: &Client,
        parts: Parts,
        body_bytes: Bytes,
        observe: Option<CallObserve>,
    ) -> Result<Response<Body>, ProxyError> {
        let parsed: Value = serde_json::from_slice(&body_bytes).unwrap_or(Value::Null);
        let model = parsed
            .get("model")
            .and_then(Value::as_str)
            .unwrap_or("qwen2.5-coder:1.5b")
            .to_string();
        let (prompt, suffix) = extract_fim_prompt(&parsed);
        let max_tokens = parsed.get("max_tokens").and_then(Value::as_u64);
        let temperature = parsed.get("temperature").and_then(Value::as_f64);
        let stops: Vec<String> = parsed
            .get("stop_sequences")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default();

        let mut options = serde_json::Map::new();
        options.insert("temperature".to_string(), json!(temperature.unwrap_or(0.0)));
        if let Some(n) = max_tokens {
            options.insert("num_predict".to_string(), json!(n));
        }
        if !stops.is_empty() {
            options.insert("stop".to_string(), json!(stops));
        }

        let ollama_payload = OllamaGenerateRequest {
            model: &model,
            prompt: &prompt,
            suffix: &suffix,
            stream: false,
            options: Value::Object(options),
        };
        let req_bytes =
            serde_json::to_vec(&ollama_payload).map_err(|_| ProxyError::BuildResponse)?;
        let url = format!("{}/api/generate", self.base_url.trim_end_matches('/'));
        let started = Instant::now();
        let upstream = client
            .post(&url)
            .header(header::CONTENT_TYPE, "application/json")
            .body(req_bytes)
            .send()
            .await
            .map_err(ProxyError::from)?;
        let status = upstream.status();
        let limit = self.max_body_bytes.max(1024 * 1024);
        let raw_resp = crate::providers::utils::read_response_bytes_capped(upstream, limit)
            .await
            .map_err(|err| match err {
                crate::providers::utils::ReadCappedError::Http(err) => ProxyError::from(err),
                crate::providers::utils::ReadCappedError::TooLarge(max) => ProxyError::anthropic(
                    StatusCode::BAD_GATEWAY,
                    "api_error",
                    format!("ollama response exceeded {max} bytes"),
                ),
            })?;
        let raw_slice = &raw_resp[..];

        if !status.is_success() {
            let err_text = String::from_utf8_lossy(raw_slice).trim().to_string();
            let msg = if err_text.is_empty() {
                format!("ollama returned HTTP {}", status.as_u16())
            } else {
                format!("ollama HTTP {}: {err_text}", status.as_u16())
            };
            record_ollama_call(
                observe.as_ref(),
                &parts,
                &body_bytes,
                &model,
                status.as_u16(),
                started,
                raw_slice,
                &msg,
                0,
                0,
            );
            return Err(ProxyError::anthropic(status, "api_error", msg));
        }

        let decoded: OllamaGenerateResponse = serde_json::from_slice(raw_slice).map_err(|err| {
            ProxyError::anthropic(
                StatusCode::BAD_GATEWAY,
                "api_error",
                format!("invalid ollama response: {err}"),
            )
        })?;
        if let Some(err) = decoded.error.filter(|e| !e.is_empty()) {
            record_ollama_call(
                observe.as_ref(),
                &parts,
                &body_bytes,
                &model,
                StatusCode::BAD_GATEWAY.as_u16(),
                started,
                raw_slice,
                &err,
                0,
                0,
            );
            return Err(ProxyError::anthropic(
                StatusCode::BAD_GATEWAY,
                "api_error",
                err,
            ));
        }

        let input_tokens = decoded.prompt_eval_count.unwrap_or(0);
        let output_tokens = decoded.eval_count.unwrap_or(0);
        let msg_id = observe
            .as_ref()
            .and_then(|o| o.request_id.as_deref())
            .map(|id| format!("msg_{id}"))
            .unwrap_or_else(|| "msg_ollama".to_string());
        let anthropic_json = json!({
            "id": msg_id,
            "type": "message",
            "role": "assistant",
            "model": model,
            "content": [{ "type": "text", "text": decoded.response }],
            "stop_reason": "end_turn",
            "stop_sequence": Value::Null,
            "usage": {
                "input_tokens": input_tokens,
                "output_tokens": output_tokens,
            }
        });
        let out_bytes =
            serde_json::to_vec(&anthropic_json).map_err(|_| ProxyError::BuildResponse)?;

        record_ollama_call(
            observe.as_ref(),
            &parts,
            &body_bytes,
            &model,
            StatusCode::OK.as_u16(),
            started,
            &out_bytes,
            &decoded.response,
            input_tokens,
            output_tokens,
        );

        Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(out_bytes))
            .map_err(|_| ProxyError::BuildResponse)
    }
}

fn extract_fim_prompt(body: &Value) -> (String, String) {
    let raw = last_user_text(body);
    if let (Some(p_start), Some(p_end)) = (raw.find("<prefix>"), raw.find("</prefix>")) {
        if p_end >= p_start + "<prefix>".len() {
            let mut prompt = String::new();
            let before_file = raw.find("<file ").unwrap_or(p_start);
            if before_file > 0 {
                prompt.push_str(&raw[..before_file]);
            }
            prompt.push_str(&raw[p_start + "<prefix>".len()..p_end]);
            let suffix = match (raw.find("<suffix>"), raw.find("</suffix>")) {
                (Some(s_start), Some(s_end)) if s_end >= s_start + "<suffix>".len() => {
                    raw[s_start + "<suffix>".len()..s_end].to_string()
                }
                _ => String::new(),
            };
            return (prompt, suffix);
        }
    }
    (raw, String::new())
}

fn last_user_text(body: &Value) -> String {
    let Some(messages) = body.get("messages").and_then(Value::as_array) else {
        return String::new();
    };
    for msg in messages.iter().rev() {
        if msg.get("role").and_then(Value::as_str) != Some("user") {
            continue;
        }
        match msg.get("content") {
            Some(Value::String(s)) => return s.clone(),
            Some(Value::Array(blocks)) => {
                let mut out = String::new();
                for block in blocks {
                    if let Some(t) = block.get("text").and_then(Value::as_str) {
                        out.push_str(t);
                    }
                }
                return out;
            }
            _ => return String::new(),
        }
    }
    String::new()
}

#[allow(clippy::too_many_arguments)]
fn record_ollama_call(
    observe: Option<&CallObserve>,
    parts: &Parts,
    request_bytes: &[u8],
    model: &str,
    status: u16,
    started: Instant,
    response_bytes: &[u8],
    output_text: &str,
    input_tokens: u64,
    output_tokens: u64,
) {
    let Some(obs) = observe else {
        return;
    };
    let input_str = String::from_utf8_lossy(request_bytes).into_owned();
    let (_, message) = describe_input(&input_str);
    let token_hash = {
        let token = token_from_headers(&parts.headers);
        if token.is_empty() {
            None
        } else {
            obs.history.token_hash(&token).ok()
        }
    };
    let parent = obs
        .session_id
        .as_deref()
        .and_then(parent_session_id)
        .map(str::to_string);
    let req_payload = request_payload(obs.kind, obs.provider, &input_str);
    let resp_payload = response_payload(
        obs.kind,
        obs.provider,
        output_text,
        "",
        response_bytes.len(),
    );
    let latency_ms = Millis::new(started.elapsed().as_millis().min(u64::MAX as u128) as u64);
    obs.history.record(FinishedCall {
        kind: obs.kind,
        provider: obs.provider,
        model: Some(model.to_string()),
        token_hash,
        message,
        input: input_str,
        output: output_text.to_string(),
        request_payload: req_payload,
        response_payload: resp_payload,
        status,
        latency_ms,
        request_bytes: request_bytes.len(),
        response_bytes: response_bytes.len(),
        input_tokens: Some(TokenCount(input_tokens)),
        output_tokens: Some(TokenCount(output_tokens)),
        cost: Some(CostMicros(0)),
        or_cost: None,
        upstream_cost: None,
        estimated_cost: Some(CostMicros(0)),
        cost_source: "none".to_string(),
        is_byok: None,
        upstream_provider: Some("ollama".to_string()),
        trimmed_from_tokens: obs.trimmed_from_tokens,
        cache_read_tokens: None,
        cache_write_tokens: None,
        generation_id: None,
        rerouting: obs.rerouting,
        rerouting_reason: obs.rerouting_reason.clone(),
        session_id: obs.session_id.clone(),
        parent_session_id: parent,
        tier_before: obs.tier_before.clone(),
        tier_after: obs.tier_after.clone(),
        trigger: obs.trigger.clone(),
        client_model: obs.client_model.clone(),
        client_has_thinking: obs.client_has_thinking,
        client_tool_names: obs.client_tool_names.clone(),
        bg_signal: obs.bg_signal,
        hk_text_signal: obs.hk_text_signal,
        request_id: obs.request_id.clone(),
    });
    if let (Some(auto), Some(request_id)) = (&obs.auto, &obs.request_id) {
        let spent_after = auto.charge(
            &obs.history,
            obs.session_id.as_deref(),
            obs.budget_key.as_deref(),
            0,
        );
        let row = CallRow {
            model: model.to_string(),
            tier: obs
                .tier_after
                .clone()
                .unwrap_or_else(|| "small".to_string()),
            decided_tier: obs.decided_tier.clone(),
            trigger: obs.trigger.clone(),
            input_tokens,
            output_tokens,
            cache_read_tokens: 0,
            cache_write_tokens: 0,
            cost_usd: 0.0,
            cost_source: "none",
            estimate_ratio: None,
            price_source: None,
            upstream_id: None,
            spent_after_usd: spent_after.map(crate::auto::micros_usd),
            route: None,
        };
        auto.record_call_persisted(
            &obs.history,
            PersistedCall {
                request_id: request_id.clone(),
                session_id: obs.session_id.clone(),
                budget_key: obs.budget_key.clone(),
                row,
            },
        );
    }
}
