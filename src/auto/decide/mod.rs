mod classify;
mod gate;
mod models;
mod route;
pub(crate) mod sticky;

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
use super::jev::Complexity;
use super::metrics;
use super::stall;

use classify::{ClassifyCtx, ClassifyTurn};
use gate::SessionGate;
use route::{RepeatCompact, RouteCtx, RoutePlan, ShapedForward};
use sticky::{apply as apply_sticky, StickyPlan};

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

    pub fn tiers(&self) -> &Tiers {
        &self.tiers
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
                previous_model: Some(row.model.as_str()),
                models: None,
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
                let outgoing = body::shape(body::ShapePlan {
                    body: &req.body,
                    model: &row.model,
                    previous_model: Some(row.model.as_str()),
                    models: loaded.as_ref(),
                });
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
    let stall = stall::detect(&req.body, req.auto.tiers.stall_window);
    let tool_results_only = body::last_user_tool_results_only(&req.body);
    let current_tier = choice
        .as_ref()
        .map(|row| row.sticky_band.as_str())
        .unwrap_or("unset");
    let classify_ctx = ClassifyCtx {
        history: req.history,
        session_id: actor.clone(),
        client: req.client,
        decisions_url: req.decisions_url,
        api_key: req.api_key,
        body: &req.body,
        all_tools: &all_tools,
        tiers: &req.auto.tiers,
        current_tier,
    };

    if let Some(row) = hold_without_classify(HoldWithoutClassify {
        choice: choice.as_ref(),
        stall,
        tool_results_only,
        user_text: &user_text,
    }) {
        return route::run(RouteCtx {
            auto: req.auto,
            body: req.body,
            models: loaded.as_ref(),
            previous_model: Some(row.model.clone()),
            plan: session_plan(&row, None, reserve, req.allow_compact, persist),
        });
    }

    let picked = if choice.is_some() {
        if user_text.trim().is_empty() || body::is_housekeeping(&user_text) {
            None
        } else {
            classify::turn(ClassifyTurn {
                ctx: &classify_ctx,
                preferred: preferred.as_deref(),
                current: choice
                    .as_ref()
                    .map(|row| row.tools.as_slice())
                    .unwrap_or(&[]),
                purpose: "reclassify",
            })
            .await
        }
    } else if user_text.trim().is_empty() || body::is_housekeeping(&user_text) {
        if stall.is_none() {
            return route::passthrough(&req.body);
        }
        None
    } else {
        match classify::fresh(&classify_ctx, preferred.as_deref()).await {
            Some(pick) => Some(pick),
            None => {
                if forced_reason.is_some() {
                    if let Some(id) = actor.clone() {
                        req.auto.clear_awaiting_compact(&id);
                    }
                }
                if let Some(trigger) = stall {
                    let band = catalog::bump_band(
                        choice
                            .as_ref()
                            .map(|row| row.sticky_band.as_str())
                            .unwrap_or("low"),
                    );
                    return route::run(RouteCtx {
                        auto: req.auto,
                        body: req.body,
                        models: loaded.as_ref(),
                        previous_model: choice.as_ref().map(|row| row.model.clone()),
                        plan: RoutePlan {
                            model: req.auto.tiers.slug(band),
                            tools: all_tools.clone(),
                            reason: Some(format!("stall_escalate:{}", trigger.as_str())),
                            reserve,
                            allow_compact: req.allow_compact,
                            persist,
                            sticky_band: choice
                                .as_ref()
                                .map(|row| row.sticky_band.clone())
                                .unwrap_or_else(|| "low".to_string()),
                            escalate_remaining: req.auto.tiers.escalate_turns,
                            escalate_band: Some(band.to_string()),
                            last_stall: Some(trigger.as_str().to_string()),
                            pending_down_band: None,
                            down_count: 0,
                        },
                    });
                }
                return route::passthrough(&req.body);
            }
        }
    };

    let (classified, tools, classify_reason) = match (picked, choice.clone()) {
        (Some(pick), Some(row)) => {
            let reason = if !catalog::ids_match(&pick.model, &row.model) {
                Some("reclassify".to_string())
            } else if pick.tools != row.tools {
                Some("tool_update".to_string())
            } else {
                None
            };
            (pick.complexity, pick.tools, reason)
        }
        (Some(pick), None) => (
            pick.complexity,
            pick.tools,
            Some(forced_reason.unwrap_or_else(|| "classify".to_string())),
        ),
        (None, Some(row)) => (band_complexity(&row.sticky_band), row.tools.clone(), None),
        (None, None) => (Complexity::Mid, all_tools.clone(), forced_reason),
    };

    let sticky = apply_sticky(StickyPlan {
        tiers: &req.auto.tiers,
        choice: choice.as_ref(),
        classified,
        preferred: preferred.as_deref(),
        stall,
        tool_results_only,
    });
    let previous_model = choice.as_ref().map(|row| row.model.clone());
    let reason = sticky.reason.or(classify_reason);
    route::run(RouteCtx {
        auto: req.auto,
        body: req.body,
        models: loaded.as_ref(),
        previous_model,
        plan: RoutePlan {
            model: sticky.model,
            tools,
            reason,
            reserve,
            allow_compact: req.allow_compact,
            persist,
            sticky_band: sticky.sticky_band,
            escalate_remaining: sticky.escalate_remaining,
            escalate_band: sticky.escalate_band,
            last_stall: sticky.last_stall,
            pending_down_band: sticky.pending_down_band,
            down_count: sticky.down_count,
        },
    })
}

struct HoldWithoutClassify<'a> {
    choice: Option<&'a super::session::SessionChoice>,
    stall: Option<stall::StallTrigger>,
    tool_results_only: bool,
    user_text: &'a str,
}

fn hold_without_classify(plan: HoldWithoutClassify<'_>) -> Option<super::session::SessionChoice> {
    let row = plan.choice?;
    if plan.stall.is_some() {
        return None;
    }
    if plan.tool_results_only
        || plan.user_text.trim().is_empty()
        || body::is_housekeeping(plan.user_text)
    {
        return Some(row.clone());
    }
    None
}

fn session_plan(
    row: &super::session::SessionChoice,
    reason: Option<String>,
    reserve: u64,
    allow_compact: bool,
    persist: bool,
) -> RoutePlan {
    RoutePlan {
        model: row.model.clone(),
        tools: row.tools.clone(),
        reason,
        reserve,
        allow_compact,
        persist,
        sticky_band: row.sticky_band.clone(),
        escalate_remaining: row.escalate_remaining,
        escalate_band: row.escalate_band.clone(),
        last_stall: row.last_stall.clone(),
        pending_down_band: row.pending_down_band.clone(),
        down_count: row.down_count,
    }
}

fn band_complexity(band: &str) -> Complexity {
    match band {
        "low" => Complexity::Low,
        "high" => Complexity::High,
        _ => Complexity::Mid,
    }
}
