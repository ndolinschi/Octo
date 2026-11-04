use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex as SyncMutex;

use std::time::{Duration, Instant};
use tokio::sync::{Mutex, OwnedMutexGuard};

use reqwest::Client;
use serde_json::Value;

use crate::history::{DecisionRow, History};
use crate::providers::openrouter::{fetch_models, DEFAULT_MODELS_URL};

use crate::providers::openrouter::OpenRouterModels;

use super::action::{Compact, Forward, Turn};
use super::body::{self, compaction_body};
use super::catalog::{self, CatalogCache, Tiers};
use super::jev;
use super::metrics::{self, context_estimate};
use super::session::{SessionChoice, Sessions};

const SESSION_TTL: Duration = Duration::from_secs(60 * 60);
const CATALOG_TTL: Duration = Duration::from_secs(10 * 60);

#[derive(Clone)]
pub struct Auto {
    tiers: Tiers,
    sessions: Arc<SyncMutex<Sessions>>,
    catalog: Arc<Mutex<CatalogCache>>,
    gates: Arc<SyncMutex<HashMap<String, Arc<Mutex<()>>>>>,
}

impl Auto {
    pub fn new(tiers: Tiers) -> Self {
        Self {
            tiers,
            sessions: Arc::new(SyncMutex::new(Sessions::new(SESSION_TTL))),
            catalog: Arc::new(Mutex::new(CatalogCache::new(CATALOG_TTL))),
            gates: Arc::new(SyncMutex::new(HashMap::new())),
        }
    }

    fn gate(&self, session_id: &str) -> SessionGate {
        let mut gates = match self.gates.lock() {
            Ok(gates) => gates,
            Err(poisoned) => poisoned.into_inner(),
        };
        let lock = gates
            .entry(session_id.to_string())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone();
        drop(gates);
        SessionGate {
            gates: Arc::clone(&self.gates),
            id: session_id.to_string(),
            lock: Arc::clone(&lock),
            guard: None,
            pending: Some(lock),
        }
    }

    pub fn mark_awaiting_compact(&self, session_id: &str) {
        let Ok(mut sessions) = self.sessions.lock() else {
            return;
        };
        if let Some(mut choice) = sessions.get(session_id) {
            choice.awaiting_compact = true;
            choice.seen = Instant::now();
            sessions.insert(session_id.to_string(), choice);
        }
    }

    pub fn clear_awaiting_compact(&self, session_id: &str) {
        let Ok(mut sessions) = self.sessions.lock() else {
            return;
        };
        if let Some(mut choice) = sessions.get(session_id) {
            choice.awaiting_compact = false;
            choice.seen = Instant::now();
            sessions.insert(session_id.to_string(), choice);
        }
    }
}

pub async fn decide(
    auto: &Auto,
    history: &History,
    client: &Client,
    decisions_url: &str,
    api_key: &str,
    body: Value,
    allow_compact: bool,
) -> Turn {
    let preferred = body::preferred_model(&body);
    let all_tools = body::tool_names(&body);
    let reserve = body::max_tokens(&body);
    let client_tokens = metrics::estimate_tokens(counted_bytes(&body));
    let actor = body::session_key(&body);
    let _session_turn = match actor.clone() {
        Some(id) => Some(auto.gate(&id).acquire().await),
        None => None,
    };
    let models = load_models(auto, client, api_key).await;
    let mut choice = match actor.clone() {
        Some(id) => auto
            .sessions
            .lock()
            .ok()
            .and_then(|mut sessions| sessions.get(&id)),
        None => None,
    };
    if models.is_none() {
        if let Some(row) = choice {
            return forward_shaped(&body, &row.model, &row.tools, None);
        }
        return passthrough(&body);
    }
    let mut forced_reason = None;
    if let Some(row) = choice.clone() {
        if row.awaiting_compact {
            if metrics::dropped(row.prev_input_tokens_est, client_tokens) {
                choice = None;
                forced_reason = Some("reclassify".to_string());
            } else if allow_compact {
                let outgoing = shaped(&body, &row.model, &row.tools);
                tracing::debug!(input_tokens_est = client_tokens, "autoroute compact repeat");
                return compact_turn(
                    auto,
                    CompactPlan {
                        body: &outgoing,
                        model: &row.model,
                        models: models.as_ref(),
                    },
                );
            } else if let Some(id) = actor.clone() {
                auto.clear_awaiting_compact(&id);
            }
        }
    }

    let user_text = body::last_user_text(&body);
    let persist = !all_tools.is_empty();
    let (model, tools, reason) = if let Some(row) = choice {
        if user_text.trim().is_empty() || body::is_housekeeping(&user_text) {
            (row.model, row.tools, None)
        } else {
            match classify_turn(
                &ClassifyCtx {
                    history,
                    session_id: actor.clone(),
                    client,
                    decisions_url,
                    api_key,
                    body: &body,
                    all_tools: &all_tools,
                    tiers: &auto.tiers,
                },
                preferred.as_deref(),
                &row.tools,
                "reclassify",
            )
            .await
            {
                Some((model, tools)) => {
                    let reason = if model != row.model {
                        Some("reclassify".to_string())
                    } else if tools != row.tools {
                        Some("tool_update".to_string())
                    } else {
                        None
                    };
                    (model, tools, reason)
                }
                None => (row.model, row.tools, None),
            }
        }
    } else if user_text.trim().is_empty() || body::is_housekeeping(&user_text) {
        return passthrough(&body);
    } else {
        match classify_fresh(
            &ClassifyCtx {
                history,
                session_id: actor.clone(),
                client,
                decisions_url,
                api_key,
                body: &body,
                all_tools: &all_tools,
                tiers: &auto.tiers,
            },
            preferred.as_deref(),
        )
        .await
        {
            Some((model, tools)) => (
                model,
                tools,
                Some(forced_reason.unwrap_or_else(|| "classify".to_string())),
            ),
            None => {
                if forced_reason.is_some() {
                    if let Some(id) = actor.clone() {
                        auto.clear_awaiting_compact(&id);
                    }
                }
                return passthrough(&body);
            }
        }
    };

    route(
        auto,
        body,
        models.as_ref(),
        RoutePlan {
            model,
            tools,
            reason,
            reserve,
            allow_compact,
            persist,
        },
    )
    .await
}

struct RoutePlan {
    model: String,
    tools: Vec<String>,
    reason: Option<String>,
    reserve: u64,
    allow_compact: bool,
    persist: bool,
}

async fn route(
    auto: &Auto,
    body: Value,
    models: Option<&OpenRouterModels>,
    mut plan: RoutePlan,
) -> Turn {
    let mut outgoing = shaped(&body, &plan.model, &plan.tools);
    let estimate = context_estimate(
        counted_bytes(&outgoing),
        catalog::context_length(models, &plan.model),
        plan.reserve,
    );
    tracing::debug!(
        input_tokens_est = estimate.input_tokens_est,
        fill = estimate.fill,
        "autoroute"
    );
    if estimate.usable < 1024 {
        return finish_overflow(
            auto,
            &body,
            &outgoing,
            models,
            estimate.input_tokens_est,
            plan,
        )
        .await;
    }
    if estimate.fill >= metrics::FILL_THRESHOLD {
        let need = estimate.input_tokens_est.saturating_mul(4) / 3 + 1;
        let tiers = auto.tiers.candidates();
        if let Some(slug) = catalog::larger_fit(&tiers, models, need, plan.reserve, &plan.model) {
            plan.model = slug;
            outgoing = shaped(&body, &plan.model, &plan.tools);
            plan.reason = Some("upgrade".to_string());
        } else {
            return finish_overflow(
                auto,
                &body,
                &outgoing,
                models,
                estimate.input_tokens_est,
                plan,
            )
            .await;
        }
    }
    let input_tokens_est = metrics::estimate_tokens(counted_bytes(&outgoing));
    if plan.persist {
        remember(
            auto,
            &body,
            &plan.model,
            &plan.tools,
            input_tokens_est,
            false,
        )
        .await;
    }
    Turn::Forward(Forward {
        body: serde_json::to_vec(&outgoing).unwrap_or_default(),
        rerouting: i64::from(plan.reason.is_some()),
        reason: plan.reason,
    })
}

async fn finish_overflow(
    auto: &Auto,
    body: &Value,
    outgoing: &Value,
    models: Option<&OpenRouterModels>,
    input_tokens_est: u64,
    plan: RoutePlan,
) -> Turn {
    if !plan.allow_compact {
        if plan.persist {
            remember(
                auto,
                body,
                &plan.model,
                &plan.tools,
                input_tokens_est,
                false,
            )
            .await;
        }
        return forward_shaped(body, &plan.model, &plan.tools, plan.reason);
    }
    if plan.persist {
        remember(auto, body, &plan.model, &plan.tools, input_tokens_est, true).await;
    }
    compact_turn(
        auto,
        CompactPlan {
            body: outgoing,
            model: &plan.model,
            models,
        },
    )
}

struct CompactPlan<'a> {
    body: &'a Value,
    model: &'a str,
    models: Option<&'a OpenRouterModels>,
}

fn forward_shaped(body: &Value, model: &str, tools: &[String], reason: Option<String>) -> Turn {
    let outgoing = shaped(body, model, tools);
    Turn::Forward(Forward {
        body: serde_json::to_vec(&outgoing).unwrap_or_default(),
        rerouting: i64::from(reason.is_some()),
        reason,
    })
}

fn shaped(body: &Value, model: &str, tools: &[String]) -> Value {
    let mut outgoing = body::with_model(body, model);
    body::filter_tools(&mut outgoing, tools);
    outgoing
}

async fn remember(
    auto: &Auto,
    body: &Value,
    model: &str,
    tools: &[String],
    prev_input_tokens_est: u64,
    awaiting_compact: bool,
) {
    let Some(id) = body::session_key(body) else {
        return;
    };
    let Ok(mut sessions) = auto.sessions.lock() else {
        return;
    };
    sessions.insert(
        id,
        SessionChoice {
            model: model.to_string(),
            tools: tools.to_vec(),
            prev_input_tokens_est,
            awaiting_compact,
            seen: Instant::now(),
        },
    );
}

fn compact_turn(auto: &Auto, plan: CompactPlan<'_>) -> Turn {
    let current_window = catalog::context_length(plan.models, plan.model);
    let fallback = auto.tiers.candidates().into_iter().find(|slug| {
        *slug != plan.model && catalog::context_length(plan.models, slug) > current_window
    });
    Turn::Compact(Compact {
        body: serde_json::to_vec(&compaction_body(plan.body, plan.model)).unwrap_or_default(),
        model: plan.model.to_string(),
        fallback_model: fallback.map(str::to_string),
    })
}

struct SessionGate {
    gates: Arc<SyncMutex<HashMap<String, Arc<Mutex<()>>>>>,
    id: String,
    lock: Arc<Mutex<()>>,
    guard: Option<OwnedMutexGuard<()>>,
    pending: Option<Arc<Mutex<()>>>,
}

impl SessionGate {
    async fn acquire(mut self) -> Self {
        let lock = self
            .pending
            .take()
            .unwrap_or_else(|| Arc::clone(&self.lock));
        self.guard = Some(lock.lock_owned().await);
        self
    }
}

impl Drop for SessionGate {
    fn drop(&mut self) {
        self.guard.take();
        let mut gates = match self.gates.lock() {
            Ok(gates) => gates,
            Err(poisoned) => poisoned.into_inner(),
        };
        if Arc::strong_count(&self.lock) == 2 {
            gates.remove(&self.id);
        }
    }
}

fn passthrough(body: &Value) -> Turn {
    Turn::Forward(Forward {
        body: serde_json::to_vec(body).unwrap_or_default(),
        rerouting: 0,
        reason: None,
    })
}

struct ClassifyCtx<'a> {
    history: &'a History,
    session_id: Option<String>,
    client: &'a Client,
    decisions_url: &'a str,
    api_key: &'a str,
    body: &'a Value,
    all_tools: &'a [String],
    tiers: &'a Tiers,
}

async fn classify_fresh(
    ctx: &ClassifyCtx<'_>,
    preferred: Option<&str>,
) -> Option<(String, Vec<String>)> {
    classify_turn(ctx, preferred, &[], "classify").await
}

async fn classify_turn(
    ctx: &ClassifyCtx<'_>,
    preferred: Option<&str>,
    current: &[String],
    purpose: &str,
) -> Option<(String, Vec<String>)> {
    if ctx.api_key.is_empty() {
        return None;
    }
    let user_text = body::last_user_text(ctx.body);
    let asked = jev::classify(jev::ClassifyRequest {
        client: ctx.client,
        decisions_url: ctx.decisions_url,
        api_key: ctx.api_key,
        user_text: &user_text,
        tool_names: ctx.all_tools,
        current_tools: current,
    })
    .await;
    record_decision(ctx.history, ctx.session_id.clone(), purpose, &asked);
    let classified = asked.parsed?;
    let model = ctx.tiers.pick(classified.complexity, preferred);
    let tools = jev::needed_tools(jev::ToolNeed {
        all: ctx.all_tools,
        current,
        enough: classified.tools_enough,
        missing: &classified.missing_tools,
    });
    Some((model, tools))
}

fn record_decision(
    history: &History,
    session_id: Option<String>,
    purpose: &str,
    asked: &jev::Asked,
) {
    let parsed = asked.parsed.as_ref();
    history.record_decision(DecisionRow {
        session_id,
        purpose: purpose.to_string(),
        model: "typesafe/jev-1.13".to_string(),
        status: asked.status,
        latency_ms: asked.latency_ms,
        user_text: user_text_from_request(&asked.request_body),
        is_hard: parsed.and_then(|row| row.is_hard),
        is_easy: parsed.and_then(|row| row.is_easy),
        tools_enough: parsed.and_then(|row| row.tools_enough_raw.clone()),
        complexity: parsed.map(|row| match row.complexity {
            jev::Complexity::Low => "low",
            jev::Complexity::Mid => "mid",
            jev::Complexity::High => "high",
        }),
        choice_rule: asked.choice_rule.to_string(),
        missing_tools: parsed.map(|row| row.missing_tools.join(",")),
        request_payload: asked.request_body.clone(),
        response_payload: asked.response_body.clone(),
    });
}

fn user_text_from_request(body: &str) -> String {
    serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|value| {
            value
                .get("state")
                .and_then(|state| state.get("user_text"))
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .unwrap_or_default()
}

async fn load_models(auto: &Auto, client: &Client, api_key: &str) -> Option<OpenRouterModels> {
    if api_key.is_empty() {
        return None;
    }
    if let Some(models) = auto.catalog.lock().await.fresh() {
        return Some(models);
    }
    let models = fetch_models(client, DEFAULT_MODELS_URL, Some(api_key))
        .await
        .ok()?;
    auto.catalog.lock().await.store(models.clone());
    Some(models)
}

fn counted_bytes(body: &Value) -> usize {
    let system = body.get("system").map(Value::to_string).unwrap_or_default();
    let messages = body
        .get("messages")
        .map(Value::to_string)
        .unwrap_or_default();
    let tools = body.get("tools").map(Value::to_string).unwrap_or_default();
    system.len() + messages.len() + tools.len()
}
