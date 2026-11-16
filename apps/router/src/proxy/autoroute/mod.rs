mod calls;
mod compact;
pub mod retry;
mod route;
mod status;

pub use calls::call;
pub use route::route;
pub use status::status;

use std::sync::Arc;
use std::time::{Duration, SystemTime};

use axum::{
    body::{to_bytes, Body, Bytes},
    extract::{Request, State},
    http::{header, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
};
use serde_json::Value;

use crate::auto::{
    bg_signal, client_has_thinking, client_tool_names_csv, is_housekeeping, last_user_text,
    preferred_model, server_tool_types, session_key, Compact, DecideRequest, Hints, RouteMeta,
    Turn,
};
use crate::history::{token_from_headers, CallKind, CallObserve, CallProvider};
use crate::proxy::error::ProxyError;
use crate::state::AppState;

const FAILURE_BODY_LIMIT: usize = 64 * 1024;

#[derive(Clone, Debug, Default)]
struct ClientSignals {
    client_model: Option<String>,
    client_has_thinking: bool,
    client_tool_names: String,
    bg_signal: bool,
    hk_text_signal: bool,
}

fn client_signals(body: &Value, patterns: &[String]) -> ClientSignals {
    let client_model = preferred_model(body);
    let hk_text_signal = is_housekeeping(&last_user_text(body));
    ClientSignals {
        bg_signal: bg_signal(client_model.as_deref(), patterns),
        client_has_thinking: client_has_thinking(body),
        client_tool_names: client_tool_names_csv(body),
        hk_text_signal,
        client_model,
    }
}

pub async fn messages(
    State(state): State<AppState>,
    request: Request,
) -> Result<Response, ProxyError> {
    run(&state, request, false)
        .await
        .map_err(ProxyError::as_anthropic_messages)
}

pub async fn chat(State(state): State<AppState>, request: Request) -> Result<Response, ProxyError> {
    run(&state, request, true).await
}

async fn run(state: &AppState, request: Request, chat: bool) -> Result<Response, ProxyError> {
    let max_body = state.config.max_body_bytes;
    let (mut parts, body) = request.into_parts();
    let body_bytes = to_bytes(body, max_body)
        .await
        .map_err(ProxyError::from_read_body)?;
    let api_key = token_from_headers(&parts.headers);
    let hints = Hints::take(&mut parts.headers).map_err(|err| {
        let err = ProxyError::anthropic(
            StatusCode::BAD_REQUEST,
            "invalid_request_error",
            err.message(),
        );
        if chat {
            err
        } else {
            err.as_anthropic_messages()
        }
    })?;
    let value: Value = serde_json::from_slice(&body_bytes).unwrap_or(Value::Null);
    let session = session_key(&value);
    if let Some(key) = hints.budget_key.as_deref() {
        state.auto.restore_budget_key(&state.history, key).await;
    }
    state.auto.bind_hints(session.as_deref(), &hints);
    let signals = client_signals(&value, &state.config.autoroute_background_model_patterns);
    let server_tools = server_tool_types(&value);
    if let Some(tool) = server_tools.first() {
        if state.config.autoroute_server_tool_mode == "reject" {
            let err = ProxyError::anthropic(
                StatusCode::BAD_REQUEST,
                "invalid_request_error",
                format!(
                    "server tool `{tool}` is not supported by the autoroute ladder; set autoroute.server_tool_mode or remove the tool"
                ),
            );
            return Err(if chat {
                err
            } else {
                err.as_anthropic_messages()
            });
        }
    }
    let turn = crate::auto::decide_with(
        DecideRequest {
            auto: &state.auto,
            history: &state.history,
            client: &state.client,
            decisions_url: &state.config.openrouter_decisions_url,
            api_key: &api_key,
            body: value,
            allow_compact: !chat,
        },
        &hints,
    )
    .await;
    match turn {
        Turn::Forward(mut forward) => {
            if let Some(tool) = server_tools.first() {
                apply_server_tool_mode(
                    &mut forward,
                    tool,
                    &state.config.autoroute_server_tool_mode,
                );
            }
            forward_turn(ForwardTurn {
                state,
                parts,
                forward,
                session,
                chat,
                signals,
                server_tool: server_tools.into_iter().next(),
                hints,
            })
            .await
        }
        Turn::Reject(reject) => {
            let mut response = ProxyError::anthropic(
                StatusCode::PAYMENT_REQUIRED,
                "billing_error",
                reject.message(),
            )
            .into_response();
            let info = ResultInfo {
                model: None,
                tier: None,
                decided_tier: None,
                trigger: "budget",
                request_id: &crate::auto::new_request_id(),
                budget: Some((reject.budget_micros, reject.spent_micros)),
            };
            apply_result_headers(&mut response, &info);
            Ok(response)
        }
        Turn::Compact(row) if chat => chat_compact(state, parts, row).await,
        Turn::Compact(row) => compact::upstream(state, &parts, &row, &hints).await,
    }
}

fn apply_server_tool_mode(forward: &mut crate::auto::Forward, _tool: &str, mode: &str) {
    if mode != "online_suffix" {
        return;
    }
    let Ok(payload) = serde_json::from_slice::<Value>(&forward.body) else {
        return;
    };
    let updated = crate::auto::with_online_suffix(&payload);
    if let Ok(bytes) = serde_json::to_vec(&updated) {
        forward.body = bytes;
    }
}

struct ForwardTurn<'a> {
    state: &'a AppState,
    parts: axum::http::request::Parts,
    forward: crate::auto::Forward,
    session: Option<String>,
    chat: bool,
    signals: ClientSignals,
    server_tool: Option<String>,
    hints: Hints,
}

async fn forward_turn(plan: ForwardTurn<'_>) -> Result<Response, ProxyError> {
    let ForwardTurn {
        state,
        parts,
        forward,
        session,
        chat,
        signals,
        server_tool,
        hints,
    } = plan;
    let retry_parts = clone_parts(&parts);
    let retry_forward = forward.clone();
    let first = dispatch_forward(DispatchForward {
        state,
        parts,
        forward,
        session: session.clone(),
        chat,
        signals: signals.clone(),
        server_tool: server_tool.clone(),
        hints: hints.clone(),
    })
    .await;
    let (response, failure) = match first {
        Ok(response) if !chat && retryable_status(response.status()) => {
            let (response, failure) = buffer_failure(response, state).await;
            (Ok(response), failure)
        }
        Err(err) if !chat && retryable_error(&err) => (Err(err), Failure::default()),
        other => return other,
    };
    let retried = retry_once(RetryOnce {
        state,
        parts: retry_parts,
        forward: retry_forward,
        session,
        chat,
        signals,
        server_tool,
        failure,
        hints,
    })
    .await;
    retried.unwrap_or(response)
}

#[derive(Default)]
struct Failure {
    delay: Option<Duration>,
    model_unavailable: bool,
}

async fn buffer_failure(response: Response, state: &AppState) -> (Response, Failure) {
    let (parts, body) = response.into_parts();
    let bytes = to_bytes(body, FAILURE_BODY_LIMIT).await.unwrap_or_default();
    let max = Duration::from_secs(state.auto.tiers().retry_after_max_secs);
    let delay = parts
        .headers
        .get(header::RETRY_AFTER)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| retry::retry_after_delay(value, SystemTime::now(), max));
    let model_unavailable =
        retry::model_unavailable(parts.status.as_u16(), &String::from_utf8_lossy(&bytes));
    (
        Response::from_parts(parts, Body::from(bytes)),
        Failure {
            delay,
            model_unavailable,
        },
    )
}

struct RetryOnce<'a> {
    state: &'a AppState,
    parts: axum::http::request::Parts,
    forward: crate::auto::Forward,
    session: Option<String>,
    chat: bool,
    signals: ClientSignals,
    server_tool: Option<String>,
    failure: Failure,
    hints: Hints,
}

async fn retry_once(plan: RetryOnce<'_>) -> Option<Result<Response, ProxyError>> {
    let payload: Value = serde_json::from_slice(&plan.forward.body).ok()?;
    let current = payload.get("model").and_then(Value::as_str)?.to_string();
    let forward = if plan.failure.model_unavailable {
        let tiers = plan.state.auto.tiers();
        // A price-swapped call that finds its model gone retries on the tier that was decided (the swap target is
        // the top of the ladder, so there is nothing above it); otherwise the next tier up.
        let decided = plan
            .forward
            .meta
            .decided_tier
            .as_deref()
            .filter(|band| matches!(*band, "low" | "mid" | "high"))
            .map(|band| tiers.slug(band));
        let (next, swap) = match decided {
            Some(slug) if tiers.band(&slug) != tiers.band(&current) => (slug, false),
            _ => (tiers.next_up(&current)?, true),
        };
        let shape = crate::auto::request_shape(&payload);
        if escalation_blocked(
            plan.state,
            plan.session.as_deref(),
            &plan.hints,
            &next,
            EscalationShape { shape, swap },
        ) {
            return None;
        }
        escalated_forward(&plan, &payload, &current, &next, swap).await?
    } else {
        let mut forward = plan.forward.clone();
        forward.meta = RouteMeta {
            tier_before: plan.forward.meta.tier_after.clone(),
            tier_after: plan.forward.meta.tier_after.clone(),
            trigger: "retry".to_string(),
            stripped: plan.forward.meta.stripped.clone(),
            decided_tier: plan.forward.meta.decided_tier.clone(),
        };
        forward.trimmed_from_tokens = None;
        forward
    };
    if let Some(delay) = plan.failure.delay.filter(|delay| !delay.is_zero()) {
        tokio::time::sleep(delay).await;
    }
    Some(
        dispatch_forward(DispatchForward {
            state: plan.state,
            parts: plan.parts,
            forward,
            session: plan.session,
            chat: plan.chat,
            signals: plan.signals,
            server_tool: plan.server_tool,
            hints: plan.hints,
        })
        .await,
    )
}

#[derive(Clone, Copy)]
pub struct EscalationShape {
    pub shape: crate::auto::RequestShape,
    /// Whether the price rule applies to `next` (it does not when retrying on the decided tier).
    pub swap: bool,
}

/// Whether an unavailable-model escalation to `next` is refused (ceiling, or budget spent and the tier the rule would
/// serve is not the cheapest).
pub fn escalation_blocked(
    state: &AppState,
    session: Option<&str>,
    hints: &Hints,
    next: &str,
    how: EscalationShape,
) -> bool {
    let tiers = state.auto.tiers();
    if matches!(
        hints.policy,
        crate::auto::TierPolicy::Ceiling | crate::auto::TierPolicy::Fixed
    ) {
        if let Some(max) = hints.tier {
            if crate::auto::band_rank(tiers.band(next)) > crate::auto::band_rank(max) {
                return true;
            }
        }
    }
    let Some((budget, spent)) = state
        .auto
        .budget_status(session, hints.budget_key.as_deref())
    else {
        return false;
    };
    if spent < budget {
        return false;
    }
    // Compare what would be served after the price rule, not the decided tier.
    let ceiling = match hints.policy {
        crate::auto::TierPolicy::Ceiling => hints.tier,
        _ => None,
    };
    let served = if how.swap && hints.policy != crate::auto::TierPolicy::Fixed {
        tiers
            .price_swap(tiers.band(next), ceiling, how.shape)
            .unwrap_or(tiers.band(next))
    } else {
        tiers.band(next)
    };
    match tiers.cheapest_band(how.shape) {
        Some(cheapest) => served != cheapest,
        None => crate::auto::band_rank(served) > crate::auto::band_rank("mid"),
    }
}

async fn escalated_forward(
    plan: &RetryOnce<'_>,
    payload: &Value,
    current: &str,
    next: &str,
    swap: bool,
) -> Option<crate::auto::Forward> {
    let tiers = plan.state.auto.tiers();
    let models = plan.state.auto.cached_models().await;
    let decided_band = tiers.band(next);
    let ceiling = match plan.hints.policy {
        crate::auto::TierPolicy::Ceiling => plan.hints.tier,
        _ => None,
    };
    let swapped = (swap && plan.hints.policy != crate::auto::TierPolicy::Fixed)
        .then(|| tiers.price_swap(decided_band, ceiling, crate::auto::request_shape(payload)))
        .flatten();
    let served = swapped.map_or_else(|| next.to_string(), |band| tiers.slug(band));
    let mut shaped = crate::auto::shape(crate::auto::ShapePlan {
        body: payload,
        model: &served,
        previous_model: Some(current),
        models: models.as_ref(),
        provider_order: &tiers.provider_order,
        allow_fallbacks: tiers.allow_fallbacks,
        strip_fields: &tiers.strip_fields,
        require_parameters: tiers.require_parameters,
        default_max_tokens: tiers.default_max_tokens,
    });
    if plan.server_tool.is_some() && plan.state.config.autoroute_server_tool_mode == "online_suffix"
    {
        shaped.body = crate::auto::with_online_suffix(&shaped.body);
    }
    let body = serde_json::to_vec(&shaped.body).ok()?;
    let meta = RouteMeta {
        tier_before: plan.forward.meta.tier_after.clone(),
        tier_after: tiers.band(&served).to_string(),
        trigger: "retry".to_string(),
        stripped: None,
        decided_tier: swapped.map(|_| decided_band.to_string()),
    }
    .with_stripped(&shaped.stripped);
    Some(crate::auto::Forward {
        body,
        meta,
        trimmed_from_tokens: None,
    })
}

struct DispatchForward<'a> {
    state: &'a AppState,
    parts: axum::http::request::Parts,
    forward: crate::auto::Forward,
    session: Option<String>,
    chat: bool,
    signals: ClientSignals,
    server_tool: Option<String>,
    hints: Hints,
}

async fn dispatch_forward(plan: DispatchForward<'_>) -> Result<Response, ProxyError> {
    let session_id = plan.session.clone();
    let tool_names = forward_tool_names(&plan.forward.body);
    let hook = (!plan.chat)
        .then_some(session_id.clone())
        .flatten()
        .map(|id| {
            let auto = plan.state.auto.clone();
            Arc::new(move |text: &str| {
                if stop_reason_is(text, "model_context_window_exceeded") {
                    auto.mark_awaiting_compact(&id);
                }
                if crate::auto::response_has_text_tool_call(text, &tool_names) {
                    auto.mark_text_tool_call_escalate(&id);
                }
            }) as Arc<dyn Fn(&str) + Send + Sync>
        });
    let request_id = crate::auto::new_request_id();
    let meta = &plan.forward.meta;
    let rerouting_reason = plan
        .server_tool
        .as_ref()
        .map(|tool| format!("server_tool:{tool}"))
        .or_else(|| meta.legacy_reason());
    let is_small = meta.tier_after == "small";
    let observe = Some(CallObserve {
        history: plan.state.history.clone(),
        kind: if plan.chat {
            CallKind::Llm
        } else {
            CallKind::Messages
        },
        provider: if is_small {
            CallProvider::Ollama
        } else {
            CallProvider::OpenRouter
        },
        rerouting: meta.rerouting(),
        rerouting_reason,
        session_id,
        tier_before: Some(meta.tier_before.clone()),
        tier_after: Some(meta.tier_after.clone()),
        decided_tier: meta.decided_tier.clone(),
        trigger: meta.trigger.clone(),
        trimmed_from_tokens: plan.forward.trimmed_from_tokens,
        client_model: plan.signals.client_model.clone(),
        client_has_thinking: Some(plan.signals.client_has_thinking),
        client_tool_names: Some(plan.signals.client_tool_names.clone()),
        bg_signal: Some(plan.signals.bg_signal),
        hk_text_signal: Some(plan.signals.hk_text_signal),
        auto: Some(plan.state.auto.clone()),
        on_response: hook,
        request_id: Some(request_id.clone()),
        budget_key: plan.hints.budget_key.clone(),
    });
    let served_model = serde_json::from_slice::<Value>(&plan.forward.body)
        .ok()
        .and_then(|value| {
            value
                .get("model")
                .and_then(Value::as_str)
                .map(str::to_string)
        });
    let budget = plan
        .state
        .auto
        .budget_status(plan.session.as_deref(), plan.hints.budget_key.as_deref());
    let tier = plan.forward.meta.tier_after.clone();
    let decided_tier = plan.forward.meta.decided_tier.clone();
    let trigger = plan.forward.meta.trigger.clone();
    let result = if plan.chat {
        plan.state
            .llm
            .openrouter
            .forward_chat_buffered(
                &plan.state.client,
                plan.parts,
                Bytes::from(plan.forward.body),
                observe,
            )
            .await
    } else if is_small {
        plan.state
            .llm
            .ollama
            .forward_messages(
                &plan.state.client,
                plan.parts,
                Bytes::from(plan.forward.body),
                observe,
            )
            .await
    } else {
        let request = Request::from_parts(plan.parts, Body::from(plan.forward.body));
        plan.state
            .llm
            .openrouter
            .forward_messages(&plan.state.client, request, observe)
            .await
    };
    result.map(|mut response| {
        apply_result_headers(
            &mut response,
            &ResultInfo {
                model: served_model.as_deref(),
                tier: Some(&tier),
                decided_tier: decided_tier.as_deref(),
                trigger: &trigger,
                request_id: &request_id,
                budget,
            },
        );
        response
    })
}

pub(super) struct ResultInfo<'a> {
    pub model: Option<&'a str>,
    pub tier: Option<&'a str>,
    pub decided_tier: Option<&'a str>,
    pub trigger: &'a str,
    pub request_id: &'a str,
    pub budget: Option<(u64, u64)>,
}

pub(super) fn apply_result_headers(response: &mut Response, info: &ResultInfo<'_>) {
    let headers = response.headers_mut();
    let mut put = |name: &'static str, value: &str| {
        if let Ok(value) = HeaderValue::from_str(value) {
            headers.insert(name, value);
        }
    };
    if let Some(model) = info.model {
        put("x-octo-model", model);
    }
    if let Some(tier) = info.tier {
        put("x-octo-tier", tier);
    }
    if let Some(decided) = info.decided_tier {
        put("x-octo-decided-tier", decided);
        put("x-octo-price-swap", "1");
    }
    put("x-octo-trigger", info.trigger);
    put("x-octo-request-id", info.request_id);
    if let Some((budget, spent)) = info.budget {
        put("x-octo-budget-usd", &usd(budget));
        put("x-octo-spent-usd", &usd(spent));
    }
}

pub(super) fn usd(micros: u64) -> String {
    format!("{}.{:06}", micros / 1_000_000, micros % 1_000_000)
}

fn clone_parts(parts: &axum::http::request::Parts) -> axum::http::request::Parts {
    let mut cloned = Request::new(Body::empty()).into_parts().0;
    cloned.method = parts.method.clone();
    cloned.uri = parts.uri.clone();
    cloned.version = parts.version;
    cloned.headers = parts.headers.clone();
    cloned
}

fn retryable_status(status: StatusCode) -> bool {
    status.as_u16() == 429 || status.is_server_error()
}

fn retryable_error(err: &ProxyError) -> bool {
    matches!(err, ProxyError::Upstream(source) if source.is_connect() || source.is_timeout())
}

async fn chat_compact(
    state: &AppState,
    parts: axum::http::request::Parts,
    compact: Compact,
) -> Result<Response, ProxyError> {
    let mut payload: Value = serde_json::from_slice(&compact.body).unwrap_or(Value::Null);
    if let Some(object) = payload.as_object_mut() {
        object.remove("compaction");
    }
    let bytes = Bytes::from(serde_json::to_vec(&payload).unwrap_or(compact.body));
    state
        .llm
        .openrouter
        .forward_chat_buffered(
            &state.client,
            parts,
            bytes,
            Some(CallObserve {
                history: state.history.clone(),
                kind: CallKind::Llm,
                provider: CallProvider::OpenRouter,
                rerouting: 0,
                rerouting_reason: None,
                session_id: None,
                tier_before: None,
                tier_after: None,
                decided_tier: None,
                trigger: "none".to_string(),
                trimmed_from_tokens: None,
                client_model: None,
                client_has_thinking: None,
                client_tool_names: None,
                bg_signal: None,
                hk_text_signal: None,
                auto: None,
                on_response: None,
                request_id: None,
                budget_key: None,
            }),
        )
        .await
}

fn forward_tool_names(body: &[u8]) -> Vec<String> {
    let Ok(value) = serde_json::from_slice::<Value>(body) else {
        return Vec::new();
    };
    value
        .get("tools")
        .and_then(Value::as_array)
        .map(|tools| {
            tools
                .iter()
                .filter_map(|tool| tool.get("name").and_then(Value::as_str).map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

pub(super) fn stop_reason_is(text: &str, reason: &str) -> bool {
    if let Ok(value) = serde_json::from_str::<Value>(text) {
        return value.get("stop_reason").and_then(Value::as_str) == Some(reason);
    }
    text.lines().any(|line| {
        let data = line.strip_prefix("data: ").unwrap_or(line);
        serde_json::from_str::<Value>(data)
            .ok()
            .and_then(|value| {
                value
                    .get("stop_reason")
                    .or_else(|| {
                        value
                            .get("delta")
                            .and_then(|delta| delta.get("stop_reason"))
                    })
                    .and_then(Value::as_str)
                    .map(|found| found == reason)
            })
            .unwrap_or(false)
    })
}
