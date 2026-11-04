use std::sync::Arc;
use std::time::{Duration, Instant};

use reqwest::Client;
use serde_json::Value;
use tokio::sync::Mutex;

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
    sessions: Arc<Mutex<Sessions>>,
    catalog: Arc<Mutex<CatalogCache>>,
}

impl Auto {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(Sessions::new(SESSION_TTL))),
            catalog: Arc::new(Mutex::new(CatalogCache::new(CATALOG_TTL))),
        }
    }

    pub async fn mark_awaiting_compact(&self, session_id: &str) {
        let mut sessions = self.sessions.lock().await;
        if let Some(mut choice) = sessions.get(session_id) {
            choice.awaiting_compact = true;
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
) -> Turn {
    let preferred = body::preferred_model(&body);
    let all_tools = body::tool_names(&body);
    let reserve = body::max_tokens(&body);
    let client_tokens = metrics::estimate_tokens(counted_bytes(&body));
    let models = load_models(auto, client, api_key).await;

    let mut choice = match body::session_id(&body) {
        Some(id) => auto.sessions.lock().await.get(&id),
        None => None,
    };
    let mut forced_reason = None;
    if let Some(row) = choice.clone() {
        if row.awaiting_compact {
            if metrics::dropped(row.prev_input_tokens_est, client_tokens) {
                choice = None;
                forced_reason = Some("reclassify".to_string());
            } else {
                return compact_turn(&body, &row.model, models.as_ref());
            }
        }
    }

    let (model, tools, reason) = if let Some(row) = choice {
        let enough = tools_cover(
            client,
            decisions_url,
            api_key,
            &body,
            &all_tools,
            &row.tools,
        )
        .await;
        let tools = jev::needed_tools(&all_tools, &row.tools, enough);
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
            None => return passthrough(&body),
        }
    };

    route(auto, body, model, tools, reason, models.as_ref(), reserve).await
}

async fn route(
    auto: &Auto,
    body: Value,
    mut model: String,
    tools: Vec<String>,
    mut reason: Option<String>,
    models: Option<&OpenRouterModels>,
    reserve: u64,
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
    if metrics::needs_compact(estimate) {
        let need = estimate.input_tokens_est.saturating_mul(4) / 3 + 1;
        if let Some(slug) = catalog::larger_fit(&TIERS, models, need, reserve, &model) {
            model = slug.to_string();
            outgoing = shaped(&body, &model, &tools);
            reason = Some("upgrade".to_string());
        } else {
            remember(auto, &body, &model, &tools, estimate.input_tokens_est, true).await;
            return compact_turn(&outgoing, &model, models);
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
    auto.sessions.lock().await.insert(
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
    Some((model, all_tools.to_vec()))
}

async fn tools_cover(
    client: &Client,
    decisions_url: &str,
    api_key: &str,
    body: &Value,
    all_tools: &[String],
    current: &[String],
) -> bool {
    if api_key.is_empty() {
        return true;
    }
    jev::classify(
        client,
        decisions_url,
        api_key,
        &body::last_user_text(body),
        all_tools,
        current,
    )
    .await
    .map(|row| row.tools_enough)
    .unwrap_or(true)
}

async fn load_models(auto: &Auto, client: &Client, api_key: &str) -> Option<OpenRouterModels> {
    if api_key.is_empty() {
        return None;
    }
    auto.catalog.lock().await.models(client, api_key).await
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
