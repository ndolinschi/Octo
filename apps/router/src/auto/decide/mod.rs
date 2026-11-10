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

use super::action::{Reject, Turn};
use super::body;
use super::catalog::{self, CatalogCache, Tiers};
use super::jev::Complexity;
use super::metrics;
use super::stall;

use super::catalog::{BudgetAction, RequestShape};
use super::session::SessionChoice;
use classify::{ClassifyCtx, ClassifyTurn};
use gate::SessionGate;
use route::{RepeatCompact, RouteCtx, RoutePlan};
use sticky::{apply as apply_sticky, cap_for_budget_shaped, StickyOutcome, StickyPlan};

const SESSION_TTL: Duration = Duration::from_secs(60 * 60);
const CATALOG_TTL: Duration = Duration::from_secs(10 * 60);
const CLASSIFIER_FAILURE_REASON: &str = "classifier_failure";
const COMPACT_NOT_APPLIED_REASON: &str = "compact_not_applied";

#[derive(Clone)]
pub struct Auto {
    tiers: Tiers,
    sessions: Arc<SyncMutex<super::session::Sessions>>,
    catalog: Arc<Mutex<CatalogCache>>,
    gates: Arc<SyncMutex<HashMap<String, Arc<Mutex<()>>>>>,
    ledger: Arc<SyncMutex<super::ledger::BudgetLedger>>,
}

impl Auto {
    pub fn new(tiers: Tiers) -> Self {
        Self {
            tiers,
            sessions: Arc::new(SyncMutex::new(super::session::Sessions::new(SESSION_TTL))),
            catalog: Arc::new(Mutex::new(CatalogCache::new(CATALOG_TTL))),
            gates: Arc::new(SyncMutex::new(HashMap::new())),
            ledger: Arc::new(SyncMutex::new(super::ledger::BudgetLedger::new(
                SESSION_TTL,
            ))),
        }
    }

    pub fn tiers(&self) -> &Tiers {
        &self.tiers
    }

    pub async fn cached_models(&self) -> Option<crate::providers::openrouter::OpenRouterModels> {
        self.catalog.lock().await.fresh()
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

    pub fn mark_compact_issued(&self, session_id: &str) {
        let Ok(mut sessions) = self.sessions.lock() else {
            return;
        };
        if let Some(mut choice) = sessions.get(session_id) {
            choice.awaiting_compact = true;
            choice.compact_issued = true;
            choice.seen = Instant::now();
            sessions.insert(session_id.to_string(), choice);
        }
    }

    pub fn mark_compaction_unapplied(&self, session_id: &str) {
        let Ok(mut sessions) = self.sessions.lock() else {
            return;
        };
        if let Some(mut choice) = sessions.get(session_id) {
            choice.awaiting_compact = false;
            choice.compact_issued = false;
            choice.compact_suppressed = true;
            choice.compact_suppressed_requests = 0;
            choice.seen = Instant::now();
            sessions.insert(session_id.to_string(), choice);
        }
    }

    pub fn rearm_compaction(&self, session_id: &str) {
        let Ok(mut sessions) = self.sessions.lock() else {
            return;
        };
        if let Some(mut choice) = sessions.get(session_id) {
            if choice.compact_suppressed {
                choice.compact_suppressed = false;
                choice.compact_suppressed_requests = 0;
                choice.seen = Instant::now();
                sessions.insert(session_id.to_string(), choice);
            }
        }
    }

    pub fn tick_compaction_cooldown(&self, session_id: &str, cooldown_requests: u32) {
        if cooldown_requests == 0 {
            return;
        }
        let Ok(mut sessions) = self.sessions.lock() else {
            return;
        };
        if let Some(mut choice) = sessions.get(session_id) {
            if !choice.compact_suppressed {
                return;
            }
            choice.compact_suppressed_requests =
                choice.compact_suppressed_requests.saturating_add(1);
            if choice.compact_suppressed_requests >= cooldown_requests {
                choice.compact_suppressed = false;
                choice.compact_suppressed_requests = 0;
            }
            sessions.insert(session_id.to_string(), choice);
        }
    }

    pub fn bind_budget_key(&self, session_key: &str, budget_key: &str) {
        if let Ok(mut ledger) = self.ledger.lock() {
            ledger.bind(session_key, budget_key);
        }
    }

    pub fn budget_key_of(&self, session_key: &str) -> Option<String> {
        self.ledger.lock().ok()?.key_for(session_key)
    }

    pub fn mark_text_tool_call_escalate(&self, session_id: &str) {
        let Ok(mut sessions) = self.sessions.lock() else {
            return;
        };
        let mut choice = sessions.get(session_id).unwrap_or_else(|| {
            SessionChoice::fresh(self.tiers.mid.clone(), Vec::new(), "unset".to_string())
        });
        let base = choice
            .escalate_band
            .as_deref()
            .filter(|_| choice.escalate_remaining > 0)
            .unwrap_or(choice.sticky_band.as_str());
        let next = catalog::bump_band(base).to_string();
        choice.escalate_band = Some(next.clone());
        choice.escalate_remaining = self.tiers.escalate_turns.max(1);
        choice.last_stall = Some("text_tool_call".to_string());
        if choice.model.is_empty()
            || catalog::band_rank(&choice.sticky_band) < catalog::band_rank(&next)
        {
            choice.model = self.tiers.slug(&next);
        }
        choice.seen = Instant::now();
        sessions.insert(session_id.to_string(), choice);
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

    pub fn session_cost_micros(&self, session_key: &str) -> u64 {
        if let Some(budget_key) = self.budget_key_of(session_key) {
            return self
                .ledger
                .lock()
                .map(|mut ledger| ledger.spent(&budget_key))
                .unwrap_or(0);
        }
        let restored = self
            .ledger
            .lock()
            .ok()
            .and_then(|mut ledger| ledger.restored(session_key))
            .unwrap_or(0);
        let Ok(mut sessions) = self.sessions.lock() else {
            return restored;
        };
        sessions
            .get(session_key)
            .map(|row| row.cost_micros)
            .unwrap_or(0)
            .saturating_add(restored)
    }

    pub fn add_session_cost(&self, session_key: &str, micros: u64) {
        if micros == 0 {
            return;
        }
        if let Some(budget_key) = self.budget_key_of(session_key) {
            if let Ok(mut ledger) = self.ledger.lock() {
                ledger.add(&budget_key, micros);
            }
            return;
        }
        let Ok(mut sessions) = self.sessions.lock() else {
            return;
        };
        let mut row = sessions.get(session_key).unwrap_or_else(|| {
            SessionChoice::fresh(self.tiers.mid.clone(), Vec::new(), "unset".to_string())
        });
        if row.model.is_empty() {
            row.model = self.tiers.mid.clone();
        }
        row.cost_micros = row.cost_micros.saturating_add(micros);
        row.seen = Instant::now();
        sessions.insert(session_key.to_string(), row);
    }

    pub fn sync_session_cost_floor(&self, session_key: &str, floor_micros: u64) {
        if floor_micros == 0 || self.budget_key_of(session_key).is_some() {
            return;
        }
        let Ok(mut sessions) = self.sessions.lock() else {
            return;
        };
        let Some(mut row) = sessions.peek(session_key) else {
            drop(sessions);
            if let Ok(mut ledger) = self.ledger.lock() {
                ledger.restore(session_key, floor_micros);
            }
            return;
        };
        if floor_micros > row.cost_micros {
            row.cost_micros = floor_micros;
            row.seen = Instant::now();
            sessions.insert(session_key.to_string(), row);
        }
    }

    pub fn session_has_spend(&self, session_key: &str) -> bool {
        self.budget_key_of(session_key).is_some() || self.session_cost_micros(session_key) > 0
    }

    pub fn seed_session(&self, session_key: &str, choice: SessionChoice) {
        let Ok(mut sessions) = self.sessions.lock() else {
            return;
        };
        sessions.insert(session_key.to_string(), choice);
    }

    pub fn session_snapshot(&self, session_key: &str) -> Option<SessionChoice> {
        let Ok(mut sessions) = self.sessions.lock() else {
            return None;
        };
        sessions.peek(session_key)
    }

    pub fn latest_session_id(&self) -> Option<String> {
        let Ok(mut sessions) = self.sessions.lock() else {
            return None;
        };
        sessions.latest_id()
    }

    pub async fn seed_catalog(&self, models: crate::providers::openrouter::OpenRouterModels) {
        self.catalog.lock().await.store(models);
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
    if let Some(id) = actor.clone() {
        if req.history.enabled() && !req.auto.session_has_spend(&id) {
            if let Ok(floor) = req.history.session_cost_micros(&id).await {
                req.auto.sync_session_cost_floor(&id, floor);
            }
        }
    }
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
    let cooldown = req.auto.tiers.compact_cooldown_requests;
    if let (Some(id), Some(row)) = (actor.as_ref(), choice.as_mut()) {
        if row.compact_suppressed && cooldown > 0 {
            req.auto.tick_compaction_cooldown(id, cooldown);
            row.compact_suppressed_requests = row.compact_suppressed_requests.saturating_add(1);
            if row.compact_suppressed_requests >= cooldown {
                row.compact_suppressed = false;
                row.compact_suppressed_requests = 0;
            }
        }
    }
    let mut allow_compact =
        req.allow_compact && !choice.as_ref().is_some_and(|row| row.compact_suppressed);
    let mut compact_event: Option<&'static str> = None;
    let raw_text = body::last_user_text(&req.body);
    let question = body::question_text(&req.body);
    let persist = !all_tools.is_empty();
    let tier_before = choice
        .as_ref()
        .map(|row| row.sticky_band.clone())
        .unwrap_or_else(|| "unset".to_string());

    let spent = actor
        .as_ref()
        .map(|id| req.auto.session_cost_micros(id))
        .unwrap_or(0);

    let budget = req.auto.tiers.session_budget_micros;
    if budget > 0 && spent >= budget && req.auto.tiers.session_budget_action == BudgetAction::Reject
    {
        return Turn::Reject(Reject {
            budget_micros: budget,
            spent_micros: spent,
            budget_key: actor.as_deref().and_then(|id| req.auto.budget_key_of(id)),
        });
    }
    let budget_shape = RequestShape {
        input_tokens: client_tokens,
        output_tokens: reserve.min(1024),
    };

    if body::is_permission_check(&raw_text) {
        let row = choice.as_ref();
        let model = row
            .map(|row| row.model.clone())
            .filter(|model| !model.is_empty())
            .or_else(|| preferred.clone())
            .unwrap_or_else(|| req.auto.tiers.mid.clone());
        return route::run(RouteCtx {
            auto: req.auto,
            body: req.body,
            models: loaded.as_ref(),
            previous_model: row.map(|row| row.model.clone()),
            plan: RoutePlan {
                model,
                tools: row
                    .map(|row| row.tools.clone())
                    .unwrap_or_else(|| all_tools.clone()),
                reason: Some("permission_check".to_string()),
                tier_before,
                reserve,
                allow_compact,
                persist: false,
                sticky_band: row
                    .map(|row| row.sticky_band.clone())
                    .unwrap_or_else(|| "unset".to_string()),
                escalate_remaining: row.map(|row| row.escalate_remaining).unwrap_or(0),
                escalate_band: row.and_then(|row| row.escalate_band.clone()),
                last_stall: row.and_then(|row| row.last_stall.clone()),
                pending_down_band: row.and_then(|row| row.pending_down_band.clone()),
                down_count: row.map(|row| row.down_count).unwrap_or(0),
                trimmed_from_tokens: None,
                spent_micros: spent,
            },
        });
    }

    if body::is_housekeeping(&raw_text) {
        return low_no_sticky(LowNoSticky {
            auto: req.auto,
            body: req.body,
            models: loaded.as_ref(),
            choice: choice.as_ref(),
            preferred: preferred.as_deref(),
            all_tools: &all_tools,
            tier_before,
            reserve,
            allow_compact,
            reason_base: "housekeeping",
            trim: true,
            persist: false,
            spent_micros: spent,
        });
    }

    if req.auto.tiers.background_by_client_model
        && body::bg_signal(
            preferred.as_deref(),
            &req.auto.tiers.background_model_patterns,
        )
    {
        return low_no_sticky(LowNoSticky {
            auto: req.auto,
            body: req.body,
            models: loaded.as_ref(),
            choice: choice.as_ref(),
            preferred: preferred.as_deref(),
            all_tools: &all_tools,
            tier_before,
            reserve,
            allow_compact,
            reason_base: "background_model",
            trim: true,
            persist: false,
            spent_micros: spent,
        });
    }

    let mut forced_reason = None;
    if let Some(row) = choice.clone() {
        if row.awaiting_compact {
            if metrics::dropped(row.prev_input_tokens_est, client_tokens) {
                choice = None;
                forced_reason = Some("reclassify".to_string());
            } else if row.compact_issued {
                tracing::warn!(
                    session_id = actor.as_deref().unwrap_or(""),
                    input_tokens_est = client_tokens,
                    previous_input_tokens_est = row.prev_input_tokens_est,
                    "autoroute compaction was not applied by the client; forwarding normally and suppressing further compaction until the context shrinks"
                );
                if let Some(id) = actor.as_ref() {
                    req.auto.mark_compaction_unapplied(id);
                }
                compact_event = Some(COMPACT_NOT_APPLIED_REASON);
                allow_compact = false;
            } else if allow_compact {
                let outgoing = body::shape(body::ShapePlan {
                    body: &req.body,
                    model: &row.model,
                    previous_model: Some(row.model.as_str()),
                    models: loaded.as_ref(),
                    provider_order: &req.auto.tiers.provider_order,
                    allow_fallbacks: req.auto.tiers.allow_fallbacks,
                    strip_fields: &req.auto.tiers.strip_fields,
                    require_parameters: req.auto.tiers.require_parameters,
                    default_max_tokens: req.auto.tiers.default_max_tokens,
                })
                .body;
                tracing::debug!(input_tokens_est = client_tokens, "autoroute compact");
                if let Some(id) = actor.as_ref() {
                    req.auto.mark_compact_issued(id);
                }
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

    let stall = stall::detect(&req.body, req.auto.tiers.stall_window);
    let tool_results_only = body::last_user_tool_results_only(&req.body);
    let current_tier = choice
        .as_ref()
        .map(|row| row.sticky_band.as_str())
        .unwrap_or("unset");
    let classify_ctx = ClassifyCtx {
        auto: req.auto,
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
        question_text: &question,
    }) {
        return route::run(RouteCtx {
            auto: req.auto,
            body: req.body,
            models: loaded.as_ref(),
            previous_model: Some(row.model.clone()),
            plan: session_plan_budget(SessionPlanBudget {
                row: &row,
                tier_before,
                reason: compact_event.map(str::to_string),
                reserve,
                allow_compact,
                persist,
                spent,
                tiers: &req.auto.tiers,
                shape: budget_shape,
            }),
        });
    }

    let subagent_unset = choice
        .as_ref()
        .is_none_or(|row| row.sticky_band == "unset" || row.model.is_empty());
    if subagent_unset
        && actor.as_deref().is_some_and(body::is_subagent_key)
        && !question.trim().is_empty()
        && stall.is_none()
    {
        return low_no_sticky(LowNoSticky {
            auto: req.auto,
            body: req.body,
            models: loaded.as_ref(),
            choice: choice.as_ref(),
            preferred: preferred.as_deref(),
            all_tools: &all_tools,
            tier_before,
            reserve,
            allow_compact,
            reason_base: "subagent_default",
            trim: false,
            persist,
            spent_micros: spent,
        });
    }

    let mut classifier_failed = false;
    let picked = if choice.is_some() {
        if question.trim().is_empty() {
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
    } else if question.trim().is_empty() {
        if stall.is_none() {
            return route::passthrough(route::Passthrough {
                auto: req.auto,
                body: &req.body,
                models: loaded.as_ref(),
            });
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
                if req.api_key.is_empty() {
                    if stall.is_none() {
                        return route::passthrough(route::Passthrough {
                            auto: req.auto,
                            body: &req.body,
                            models: loaded.as_ref(),
                        });
                    }
                } else {
                    tracing::warn!(
                        session_id = actor.as_deref().unwrap_or(""),
                        tier = %req.auto.tiers.classifier_failure_tier,
                        "autoroute classifier failed; using classifier_failure_tier"
                    );
                    classifier_failed = true;
                }
                None
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
        (None, None) if classifier_failed => (
            band_complexity(&req.auto.tiers.classifier_failure_tier),
            all_tools.clone(),
            Some(CLASSIFIER_FAILURE_REASON.to_string()),
        ),
        (None, None) => (
            if stall.is_some() {
                Complexity::Low
            } else {
                Complexity::Mid
            },
            all_tools.clone(),
            forced_reason,
        ),
    };

    let mut sticky = apply_sticky(StickyPlan {
        tiers: &req.auto.tiers,
        choice: choice.as_ref(),
        classified,
        preferred: preferred.as_deref(),
        stall,
        tool_results_only,
    });
    cap_for_budget_shaped(&mut sticky, &req.auto.tiers, spent, budget_shape);
    let previous_model = choice.as_ref().map(|row| row.model.clone());
    let reason = sticky
        .reason
        .or(classify_reason)
        .or_else(|| compact_event.map(str::to_string));
    route::run(RouteCtx {
        auto: req.auto,
        body: req.body,
        models: loaded.as_ref(),
        previous_model,
        plan: RoutePlan {
            model: sticky.model,
            tools,
            reason,
            tier_before,
            reserve,
            allow_compact,
            persist,
            sticky_band: sticky.sticky_band,
            escalate_remaining: sticky.escalate_remaining,
            escalate_band: sticky.escalate_band,
            last_stall: sticky.last_stall,
            pending_down_band: sticky.pending_down_band,
            down_count: sticky.down_count,
            trimmed_from_tokens: None,
            spent_micros: spent,
        },
    })
}

struct HoldWithoutClassify<'a> {
    choice: Option<&'a super::session::SessionChoice>,
    stall: Option<stall::StallTrigger>,
    tool_results_only: bool,
    question_text: &'a str,
}

fn hold_without_classify(plan: HoldWithoutClassify<'_>) -> Option<super::session::SessionChoice> {
    let row = plan.choice?;
    if plan.stall.is_some() {
        return None;
    }
    if plan.tool_results_only || plan.question_text.trim().is_empty() {
        return Some(row.clone());
    }
    None
}

struct LowNoSticky<'a> {
    auto: &'a Auto,
    body: Value,
    models: Option<&'a crate::providers::openrouter::OpenRouterModels>,
    choice: Option<&'a super::session::SessionChoice>,
    preferred: Option<&'a str>,
    all_tools: &'a [String],
    tier_before: String,
    reserve: u64,
    allow_compact: bool,
    reason_base: &'static str,
    trim: bool,
    persist: bool,
    spent_micros: u64,
}

fn low_no_sticky(plan: LowNoSticky<'_>) -> Turn {
    let model = plan.auto.tiers.pick(Complexity::Low, plan.preferred);
    let row = plan.choice;
    let (body, trimmed_from_tokens, reason) = if plan.trim {
        let pre_tokens = metrics::estimate_tokens(models::counted_bytes(&plan.body));
        let trimmed = body::trim_housekeeping(
            &plan.body,
            plan.auto.tiers.housekeeping_keep_messages,
            pre_tokens,
        );
        let reason = if plan.reason_base == "housekeeping" && trimmed.shortened {
            "housekeeping_trimmed"
        } else {
            plan.reason_base
        };
        (trimmed.body, trimmed.trimmed_from_tokens, reason)
    } else {
        (plan.body, None, plan.reason_base)
    };
    route::run(RouteCtx {
        auto: plan.auto,
        body,
        models: plan.models,
        previous_model: row.map(|row| row.model.clone()),
        plan: RoutePlan {
            model,
            tools: row
                .map(|row| row.tools.clone())
                .unwrap_or_else(|| plan.all_tools.to_vec()),
            reason: Some(reason.to_string()),
            tier_before: plan.tier_before,
            reserve: plan.reserve,
            allow_compact: plan.allow_compact,
            persist: plan.persist,
            sticky_band: if plan.persist {
                "low".to_string()
            } else {
                row.map(|row| row.sticky_band.clone())
                    .unwrap_or_else(|| "unset".to_string())
            },
            escalate_remaining: row.map(|row| row.escalate_remaining).unwrap_or(0),
            escalate_band: row.and_then(|row| row.escalate_band.clone()),
            last_stall: row.and_then(|row| row.last_stall.clone()),
            pending_down_band: row.and_then(|row| row.pending_down_band.clone()),
            down_count: row.map(|row| row.down_count).unwrap_or(0),
            trimmed_from_tokens,
            spent_micros: plan.spent_micros,
        },
    })
}

fn session_plan_budget(plan: SessionPlanBudget<'_>) -> RoutePlan {
    let model = if plan.row.model.is_empty() {
        plan.tiers.mid.clone()
    } else {
        plan.row.model.clone()
    };
    let mut sticky = StickyOutcome {
        model,
        sticky_band: plan.row.sticky_band.clone(),
        escalate_remaining: plan.row.escalate_remaining,
        escalate_band: plan.row.escalate_band.clone(),
        last_stall: plan.row.last_stall.clone(),
        pending_down_band: plan.row.pending_down_band.clone(),
        down_count: plan.row.down_count,
        reason: plan.reason,
    };
    cap_for_budget_shaped(&mut sticky, plan.tiers, plan.spent, plan.shape);
    RoutePlan {
        model: sticky.model,
        tools: plan.row.tools.clone(),
        reason: sticky.reason,
        tier_before: plan.tier_before,
        reserve: plan.reserve,
        allow_compact: plan.allow_compact,
        persist: plan.persist,
        sticky_band: sticky.sticky_band,
        escalate_remaining: plan.row.escalate_remaining,
        escalate_band: plan.row.escalate_band.clone(),
        last_stall: plan.row.last_stall.clone(),
        pending_down_band: plan.row.pending_down_band.clone(),
        down_count: plan.row.down_count,
        trimmed_from_tokens: None,
        spent_micros: plan.spent,
    }
}

struct SessionPlanBudget<'a> {
    row: &'a super::session::SessionChoice,
    tier_before: String,
    reason: Option<String>,
    reserve: u64,
    allow_compact: bool,
    persist: bool,
    spent: u64,
    tiers: &'a Tiers,
    shape: RequestShape,
}

fn band_complexity(band: &str) -> Complexity {
    match band {
        "low" => Complexity::Low,
        "high" => Complexity::High,
        _ => Complexity::Mid,
    }
}
