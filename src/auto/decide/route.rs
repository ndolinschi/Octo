use std::time::Instant;

use serde_json::Value;

use crate::providers::openrouter::OpenRouterModels;

use super::super::action::{Compact, Forward, Turn};
use super::super::body::{self, compaction_body, ShapePlan};
use super::super::catalog::{self, LargerFit};
use super::super::metrics::{self, context_estimate};
use super::super::session::SessionChoice;
use super::models::counted_bytes;
use super::Auto;

pub(super) struct RoutePlan {
    pub model: String,
    pub tools: Vec<String>,
    pub reason: Option<String>,
    pub reserve: u64,
    pub allow_compact: bool,
    pub persist: bool,
    pub sticky_band: String,
    pub escalate_remaining: u32,
    pub escalate_band: Option<String>,
    pub last_stall: Option<String>,
    pub pending_down_band: Option<String>,
    pub down_count: u32,
}

pub(super) struct RouteCtx<'a> {
    pub auto: &'a Auto,
    pub body: Value,
    pub models: Option<&'a OpenRouterModels>,
    pub previous_model: Option<String>,
    pub plan: RoutePlan,
}

struct OverflowCtx<'a> {
    auto: &'a Auto,
    body: &'a Value,
    outgoing: &'a Value,
    models: Option<&'a OpenRouterModels>,
    previous_model: Option<&'a str>,
    input_tokens_est: u64,
    plan: RoutePlan,
}

struct RememberPlan<'a> {
    auto: &'a Auto,
    body: &'a Value,
    model: &'a str,
    tools: &'a [String],
    prev_input_tokens_est: u64,
    awaiting_compact: bool,
    sticky_band: &'a str,
    escalate_remaining: u32,
    escalate_band: Option<&'a str>,
    last_stall: Option<&'a str>,
    pending_down_band: Option<&'a str>,
    down_count: u32,
}

pub(super) struct RepeatCompact<'a> {
    pub auto: &'a Auto,
    pub body: &'a Value,
    pub model: &'a str,
    pub models: Option<&'a OpenRouterModels>,
}

pub(super) fn run(ctx: RouteCtx<'_>) -> Turn {
    let mut plan = ctx.plan;
    let previous = ctx.previous_model.as_deref();
    let mut outgoing = shaped(ShapeArgs {
        body: &ctx.body,
        model: &plan.model,
        previous_model: previous,
        models: ctx.models,
    });
    let estimate = context_estimate(
        counted_bytes(&outgoing),
        catalog::context_length(ctx.models, &plan.model),
        plan.reserve,
    );
    tracing::debug!(
        input_tokens_est = estimate.input_tokens_est,
        fill = estimate.fill,
        "autoroute"
    );
    if estimate.usable < 1024 {
        return finish_overflow(OverflowCtx {
            auto: ctx.auto,
            body: &ctx.body,
            outgoing: &outgoing,
            models: ctx.models,
            previous_model: previous,
            input_tokens_est: estimate.input_tokens_est,
            plan,
        });
    }
    if estimate.fill >= metrics::FILL_THRESHOLD {
        let need = estimate.input_tokens_est.saturating_mul(4) / 3 + 1;
        let tiers = ctx.auto.tiers.candidates();
        if let Some(slug) = catalog::larger_fit(LargerFit {
            candidates: &tiers,
            models: ctx.models,
            input_tokens: need,
            max_tokens: plan.reserve,
            current: &plan.model,
        }) {
            plan.model = slug;
            outgoing = shaped(ShapeArgs {
                body: &ctx.body,
                model: &plan.model,
                previous_model: previous,
                models: ctx.models,
            });
            plan.reason = Some("upgrade".to_string());
        } else {
            return finish_overflow(OverflowCtx {
                auto: ctx.auto,
                body: &ctx.body,
                outgoing: &outgoing,
                models: ctx.models,
                previous_model: previous,
                input_tokens_est: estimate.input_tokens_est,
                plan,
            });
        }
    }
    let input_tokens_est = metrics::estimate_tokens(counted_bytes(&outgoing));
    if plan.persist {
        remember(RememberPlan {
            auto: ctx.auto,
            body: &ctx.body,
            model: &plan.model,
            tools: &plan.tools,
            prev_input_tokens_est: input_tokens_est,
            awaiting_compact: false,
            sticky_band: &plan.sticky_band,
            escalate_remaining: plan.escalate_remaining,
            escalate_band: plan.escalate_band.as_deref(),
            last_stall: plan.last_stall.as_deref(),
            pending_down_band: plan.pending_down_band.as_deref(),
            down_count: plan.down_count,
        });
    }
    encode_forward(&outgoing, plan.reason)
}

fn finish_overflow(ctx: OverflowCtx<'_>) -> Turn {
    let plan = ctx.plan;
    if !plan.allow_compact {
        if plan.persist {
            remember(RememberPlan {
                auto: ctx.auto,
                body: ctx.body,
                model: &plan.model,
                tools: &plan.tools,
                prev_input_tokens_est: ctx.input_tokens_est,
                awaiting_compact: false,
                sticky_band: &plan.sticky_band,
                escalate_remaining: plan.escalate_remaining,
                escalate_band: plan.escalate_band.as_deref(),
                last_stall: plan.last_stall.as_deref(),
                pending_down_band: plan.pending_down_band.as_deref(),
                down_count: plan.down_count,
            });
        }
        return forward_shaped(ShapedForward {
            body: ctx.body,
            model: &plan.model,
            previous_model: ctx.previous_model,
            models: ctx.models,
            reason: plan.reason,
        });
    }
    if plan.persist {
        remember(RememberPlan {
            auto: ctx.auto,
            body: ctx.body,
            model: &plan.model,
            tools: &plan.tools,
            prev_input_tokens_est: ctx.input_tokens_est,
            awaiting_compact: true,
            sticky_band: &plan.sticky_band,
            escalate_remaining: plan.escalate_remaining,
            escalate_band: plan.escalate_band.as_deref(),
            last_stall: plan.last_stall.as_deref(),
            pending_down_band: plan.pending_down_band.as_deref(),
            down_count: plan.down_count,
        });
    }
    repeat_compact(RepeatCompact {
        auto: ctx.auto,
        body: ctx.outgoing,
        model: &plan.model,
        models: ctx.models,
    })
}

pub(super) struct ShapedForward<'a> {
    pub body: &'a Value,
    pub model: &'a str,
    pub previous_model: Option<&'a str>,
    pub models: Option<&'a OpenRouterModels>,
    pub reason: Option<String>,
}

pub(super) fn forward_shaped(plan: ShapedForward<'_>) -> Turn {
    encode_forward(
        &shaped(ShapeArgs {
            body: plan.body,
            model: plan.model,
            previous_model: plan.previous_model,
            models: plan.models,
        }),
        plan.reason,
    )
}

pub(super) fn passthrough(body: &Value) -> Turn {
    encode_forward(body, None)
}

pub(super) fn repeat_compact(plan: RepeatCompact<'_>) -> Turn {
    let current_window = catalog::context_length(plan.models, plan.model);
    let fallback = plan
        .auto
        .tiers
        .candidates()
        .into_iter()
        .filter_map(|slug| {
            if catalog::ids_match(slug, plan.model) {
                return None;
            }
            let window = catalog::context_length(plan.models, slug);
            (window > current_window).then_some((window, slug))
        })
        .min_by_key(|(window, _)| *window)
        .map(|(_, slug)| slug);
    match serde_json::to_vec(&compaction_body(plan.body, plan.model)) {
        Ok(body) => Turn::Compact(Compact {
            body,
            model: plan.model.to_string(),
            fallback_model: fallback.map(str::to_string),
        }),
        Err(err) => {
            tracing::error!(%err, "autoroute compact encode failed");
            passthrough(plan.body)
        }
    }
}

struct ShapeArgs<'a> {
    body: &'a Value,
    model: &'a str,
    previous_model: Option<&'a str>,
    models: Option<&'a OpenRouterModels>,
}

fn shaped(plan: ShapeArgs<'_>) -> Value {
    body::shape(ShapePlan {
        body: plan.body,
        model: plan.model,
        previous_model: plan.previous_model,
        models: plan.models,
    })
}

fn remember(plan: RememberPlan<'_>) {
    let Some(id) = body::session_key(plan.body) else {
        return;
    };
    let Ok(mut sessions) = plan.auto.sessions.lock() else {
        return;
    };
    sessions.insert(
        id,
        SessionChoice {
            model: plan.model.to_string(),
            tools: plan.tools.to_vec(),
            prev_input_tokens_est: plan.prev_input_tokens_est,
            awaiting_compact: plan.awaiting_compact,
            seen: Instant::now(),
            sticky_band: plan.sticky_band.to_string(),
            escalate_remaining: plan.escalate_remaining,
            escalate_band: plan.escalate_band.map(str::to_string),
            last_stall: plan.last_stall.map(str::to_string),
            pending_down_band: plan.pending_down_band.map(str::to_string),
            down_count: plan.down_count,
        },
    );
}

fn encode_forward(body: &Value, reason: Option<String>) -> Turn {
    match serde_json::to_vec(body) {
        Ok(bytes) => Turn::Forward(Forward {
            body: bytes,
            rerouting: i64::from(reason.is_some()),
            reason,
        }),
        Err(err) => {
            tracing::error!(%err, "autoroute encode failed");
            Turn::Forward(Forward {
                body: Vec::new(),
                rerouting: 0,
                reason: None,
            })
        }
    }
}
