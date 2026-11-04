use std::time::Instant;

use serde_json::Value;

use crate::providers::openrouter::OpenRouterModels;

use super::super::action::{Compact, Forward, Turn};
use super::super::body::{self, compaction_body};
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
}

pub(super) struct RouteCtx<'a> {
    pub auto: &'a Auto,
    pub body: Value,
    pub models: Option<&'a OpenRouterModels>,
    pub plan: RoutePlan,
}

struct OverflowCtx<'a> {
    auto: &'a Auto,
    body: &'a Value,
    outgoing: &'a Value,
    models: Option<&'a OpenRouterModels>,
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
}

pub(super) struct RepeatCompact<'a> {
    pub auto: &'a Auto,
    pub body: &'a Value,
    pub model: &'a str,
    pub models: Option<&'a OpenRouterModels>,
}

pub(super) fn run(ctx: RouteCtx<'_>) -> Turn {
    let mut plan = ctx.plan;
    let mut outgoing = shaped(&ctx.body, &plan.model, &plan.tools);
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
            outgoing = shaped(&ctx.body, &plan.model, &plan.tools);
            plan.reason = Some("upgrade".to_string());
        } else {
            return finish_overflow(OverflowCtx {
                auto: ctx.auto,
                body: &ctx.body,
                outgoing: &outgoing,
                models: ctx.models,
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
            });
        }
        return forward_shaped(ShapedForward {
            body: ctx.body,
            model: &plan.model,
            tools: &plan.tools,
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
    pub tools: &'a [String],
    pub reason: Option<String>,
}

pub(super) fn forward_shaped(plan: ShapedForward<'_>) -> Turn {
    encode_forward(&shaped(plan.body, plan.model, plan.tools), plan.reason)
}

pub(super) fn passthrough(body: &Value) -> Turn {
    encode_forward(body, None)
}

pub(super) fn repeat_compact(plan: RepeatCompact<'_>) -> Turn {
    let current_window = catalog::context_length(plan.models, plan.model);
    let fallback = plan.auto.tiers.candidates().into_iter().find(|slug| {
        !catalog::ids_match(slug, plan.model)
            && catalog::context_length(plan.models, slug) > current_window
    });
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

fn shaped(body: &Value, model: &str, tools: &[String]) -> Value {
    let mut outgoing = body::with_model(body, model);
    body::filter_tools(&mut outgoing, tools);
    outgoing
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
