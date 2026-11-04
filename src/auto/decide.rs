use std::sync::Arc;
use std::sync::Mutex as SyncMutex;

use std::time::{Duration, Instant};
use tokio::sync::Mutex;

use reqwest::Client;
use serde_json::Value;

use crate::providers::openrouter::{fetch_models, DEFAULT_MODELS_URL};

use crate::providers::openrouter::OpenRouterModels;

use super::action::{Compact, Forward, Turn};
use super::body::{self, compaction_body};
use super::catalog::{self, CatalogCache};
use super::jev;
use super::metrics::{self, context_estimate};
use super::session::{SessionChoice, Sessions};

const SESSION_TTL: Duration = Duration::from_secs(60 * 60);
const CATALOG_TTL: Duration = Duration::from_secs(10 * 60);
const TIERS: [&str; 3] = [catalog::LOW_MODEL, catalog::MID_MODEL, catalog::HIGH_MODEL];

#[derive(Clone)]
pub struct Auto {
    sessions: Arc<SyncMutex<Sessions>>,
    catalog: Arc<Mutex<CatalogCache>>,
}

impl Auto {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(SyncMutex::new(Sessions::new(SESSION_TTL))),
            catalog: Arc::new(Mutex::new(CatalogCache::new(CATALOG_TTL))),
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

impl Default for Auto {
    fn default() -> Self {
        Self::new()
    }
}

pub async fn decide(
    auto: &Auto,
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
    let models = load_models(auto, client, api_key).await;
    let mut choice = match body::session_id(&body) {
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
            } else {
                let outgoing = shaped(&body, &row.model, &row.tools);
                tracing::debug!(input_tokens_est = client_tokens, "autoroute compact repeat");
                return compact_turn(&outgoing, &row.model, models.as_ref());
            }
        }
    }

    let (model, tools, reason) = if let Some(row) = choice {
        let (enough, missing) = tools_cover(
            client,
            decisions_url,
            api_key,
            &body,
            &all_tools,
            &row.tools,
        )
        .await;
        let tools = jev::needed_tools(&all_tools, &row.tools, enough, &missing);
        let reason = (tools != row.tools).then(|| "tool_update".to_string());
        (row.model, tools, reason)
    } else {
        match classify_fresh(
            client,
            decisions_url,
            api_key,
            &body,
            &all_tools,
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
                    if let Some(id) = body::session_id(&body) {
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
        model,
        tools,
        reason,
        models.as_ref(),
        reserve,
        allow_compact,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
async fn route(
    auto: &Auto,
    body: Value,
    mut model: String,
    tools: Vec<String>,
    mut reason: Option<String>,
    models: Option<&OpenRouterModels>,
    reserve: u64,
    allow_compact: bool,
) -> Turn {
    let mut outgoing = shaped(&body, &model, &tools);
    let estimate = context_estimate(
        counted_bytes(&outgoing),
        catalog::context_length(models, &model),
        reserve,
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
            &model,
            &tools,
            estimate.input_tokens_est,
            models,
            allow_compact,
        )
        .await;
    }
    if estimate.fill >= metrics::FILL_THRESHOLD {
        let need = estimate.input_tokens_est.saturating_mul(4) / 3 + 1;
        if let Some(slug) = catalog::larger_fit(&TIERS, models, need, reserve, &model) {
            model = slug.to_string();
            outgoing = shaped(&body, &model, &tools);
            reason = Some("upgrade".to_string());
        } else {
            return finish_overflow(
                auto,
                &body,
                &outgoing,
                &model,
                &tools,
                estimate.input_tokens_est,
                models,
                allow_compact,
            )
            .await;
        }
    }
    let input_tokens_est = metrics::estimate_tokens(counted_bytes(&outgoing));
    remember(auto, &body, &model, &tools, input_tokens_est, false).await;
    Turn::Forward(Forward {
        body: serde_json::to_vec(&outgoing).unwrap_or_default(),
        rerouting: i64::from(reason.is_some()),
        reason,
    })
}

#[allow(clippy::too_many_arguments)]
async fn finish_overflow(
    auto: &Auto,
    body: &Value,
    outgoing: &Value,
    model: &str,
    tools: &[String],
    input_tokens_est: u64,
    models: Option<&OpenRouterModels>,
    allow_compact: bool,
) -> Turn {
    if !allow_compact {
        remember(auto, body, model, tools, input_tokens_est, false).await;
        return forward_shaped(body, model, tools, None);
    }
    remember(auto, body, model, tools, input_tokens_est, true).await;
    compact_turn(outgoing, model, models)
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
    let Some(id) = body::session_id(body) else {
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

fn compact_turn(body: &Value, model: &str, models: Option<&OpenRouterModels>) -> Turn {
    let current_window = catalog::context_length(models, model);
    let fallback = TIERS
        .iter()
        .copied()
        .find(|slug| *slug != model && catalog::context_length(models, slug) > current_window);
    Turn::Compact(Compact {
        body: serde_json::to_vec(&compaction_body(body, model)).unwrap_or_default(),
        model: model.to_string(),
        fallback_model: fallback.map(str::to_string),
    })
}

fn passthrough(body: &Value) -> Turn {
    Turn::Forward(Forward {
        body: serde_json::to_vec(body).unwrap_or_default(),
        rerouting: 0,
        reason: None,
    })
}

async fn classify_fresh(
    client: &Client,
    decisions_url: &str,
    api_key: &str,
    body: &Value,
    all_tools: &[String],
    preferred: Option<&str>,
) -> Option<(String, Vec<String>)> {
    if api_key.is_empty() {
        return None;
    }
    let classified = jev::classify(
        client,
        decisions_url,
        api_key,
        &body::last_user_text(body),
        all_tools,
        &[],
    )
    .await?;
    let model = catalog::pick_model(classified.complexity, preferred);
    let tools = jev::needed_tools(all_tools, &[], false, &classified.missing_tools);
    Some((model, tools))
}

async fn tools_cover(
    client: &Client,
    decisions_url: &str,
    api_key: &str,
    body: &Value,
    all_tools: &[String],
    current: &[String],
) -> (bool, Vec<String>) {
    if api_key.is_empty() {
        return (true, Vec::new());
    }
    match jev::classify(
        client,
        decisions_url,
        api_key,
        &body::last_user_text(body),
        all_tools,
        current,
    )
    .await
    {
        Some(row) => (row.tools_enough, row.missing_tools),
        None => (true, Vec::new()),
    }
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
