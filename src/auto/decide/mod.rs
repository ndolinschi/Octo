mod classify;
mod gate;
mod models;
mod route;

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex as SyncMutex;
use std::time::{Duration, Instant};

use tokio::sync::Mutex;

use reqwest::Client;
use serde_json::Value;

use crate::history::History;

use super::action::Turn;
use super::body;
use super::catalog::{self, CatalogCache, Tiers};
use super::metrics;

use classify::{ClassifyCtx, ClassifyTurn};
use gate::SessionGate;
use route::{RepeatCompact, RouteCtx, RoutePlan, ShapedForward};

const SESSION_TTL: Duration = Duration::from_secs(60 * 60);
const CATALOG_TTL: Duration = Duration::from_secs(10 * 60);

#[derive(Clone)]
pub struct Auto {
    tiers: Tiers,
    sessions: Arc<SyncMutex<super::session::Sessions>>,
    catalog: Arc<Mutex<CatalogCache>>,
    gates: Arc<SyncMutex<HashMap<String, Arc<Mutex<()>>>>>,
}

impl Auto {
    pub fn new(tiers: Tiers) -> Self {
        Self {
            tiers,
            sessions: Arc::new(SyncMutex::new(super::session::Sessions::new(SESSION_TTL))),
            catalog: Arc::new(Mutex::new(CatalogCache::new(CATALOG_TTL))),
            gates: Arc::new(SyncMutex::new(HashMap::new())),
        }
    }

    fn gate(&self, session_id: &str) -> SessionGate {
        SessionGate::new(Arc::clone(&self.gates), session_id)
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

pub struct DecideRequest<'a> {
    pub auto: &'a Auto,
    pub history: &'a History,
    pub client: &'a Client,
    pub decisions_url: &'a str,
    pub api_key: &'a str,
    pub body: Value,
    pub allow_compact: bool,
}

pub async fn decide(req: DecideRequest<'_>) -> Turn {
    let preferred = body::preferred_model(&req.body);
    let all_tools = body::tool_names(&req.body);
    let reserve = body::max_tokens(&req.body);
    let client_tokens = metrics::estimate_tokens(models::counted_bytes(&req.body));
    let actor = body::session_key(&req.body);
    let _session_turn = match actor.clone() {
        Some(id) => Some(req.auto.gate(&id).acquire().await),
        None => None,
    };
    let loaded = models::load(req.auto, req.client, req.api_key).await;
    let mut choice = match actor.clone() {
        Some(id) => req
            .auto
            .sessions
            .lock()
            .ok()
            .and_then(|mut sessions| sessions.get(&id)),
        None => None,
    };
    if loaded.is_none() {
        if let Some(row) = choice {
            return route::forward_shaped(ShapedForward {
                body: &req.body,
                model: &row.model,
                tools: &row.tools,
                reason: None,
            });
        }
        return route::passthrough(&req.body);
    }
    let mut forced_reason = None;
    if let Some(row) = choice.clone() {
        if row.awaiting_compact {
            if metrics::dropped(row.prev_input_tokens_est, client_tokens) {
                choice = None;
                forced_reason = Some("reclassify".to_string());
            } else if req.allow_compact {
                let outgoing = body::with_model(&req.body, &row.model);
                let mut outgoing = outgoing;
                body::filter_tools(&mut outgoing, &row.tools);
                tracing::debug!(input_tokens_est = client_tokens, "autoroute compact repeat");
                return route::repeat_compact(RepeatCompact {
                    auto: req.auto,
                    body: &outgoing,
                    model: &row.model,
                    models: loaded.as_ref(),
                });
            } else if let Some(id) = actor.clone() {
                req.auto.clear_awaiting_compact(&id);
            }
        }
    }

    let user_text = body::last_user_text(&req.body);
    let persist = !all_tools.is_empty();
    let classify_ctx = ClassifyCtx {
        history: req.history,
        session_id: actor.clone(),
        client: req.client,
        decisions_url: req.decisions_url,
        api_key: req.api_key,
        body: &req.body,
        all_tools: &all_tools,
        tiers: &req.auto.tiers,
    };
    let (model, tools, reason) = if let Some(row) = choice {
        if user_text.trim().is_empty() || body::is_housekeeping(&user_text) {
            (row.model, row.tools, None)
        } else {
            match classify::turn(ClassifyTurn {
                ctx: &classify_ctx,
                preferred: preferred.as_deref(),
                current: &row.tools,
                purpose: "reclassify",
            })
            .await
            {
                Some((model, tools)) => {
                    let reason = if !catalog::ids_match(&model, &row.model) {
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
        return route::passthrough(&req.body);
    } else {
        match classify::fresh(&classify_ctx, preferred.as_deref()).await {
            Some((model, tools)) => (
                model,
                tools,
                Some(forced_reason.unwrap_or_else(|| "classify".to_string())),
            ),
            None => {
                if forced_reason.is_some() {
                    if let Some(id) = actor.clone() {
                        req.auto.clear_awaiting_compact(&id);
                    }
                }
                return route::passthrough(&req.body);
            }
        }
    };

    route::run(RouteCtx {
        auto: req.auto,
        body: req.body,
        models: loaded.as_ref(),
        plan: RoutePlan {
            model,
            tools,
            reason,
            reserve,
            allow_compact: req.allow_compact,
            persist,
        },
    })
}
