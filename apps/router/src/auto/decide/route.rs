use std::time::Instant;

use serde_json::Value;

use crate::providers::openrouter::OpenRouterModels;

use super::super::action::{Compact, Forward, Turn};
use super::super::body::{self, compaction_body, ShapePlan};
use super::super::catalog::RequestShape;
use super::super::catalog::{self, LargerFit, Tiers};
use super::super::metrics::{self, context_estimate};
use super::super::routing::RouteMeta;
use super::super::session::SessionChoice;
use super::models::counted_bytes;
use super::sticky::{cap_for_budget_with, StickyOutcome};
use super::{Auto, Limits};

pub(super) struct Served {
    pub model: String,
    pub decided_tier: Option<String>,
}

fn swap_target(
    tiers: &Tiers,
    limits: &Limits,
    models: Option<&OpenRouterModels>,
    reserve: u64,
    band: &str,
) -> Option<&'static str> {
    tiers.price_swap_where(band, limits.max_band, limits.shape, |target| {
        tiers.swap_fits_window(models, band, target, limits.shape, reserve)
    })
}

/// The model served for a decided one: the price rule's pick unless the rule is off, the policy is `fixed`, the
/// model came from the window upgrade, or the cheaper tier's window cannot hold the request.
pub(super) fn serve(
    tiers: &Tiers,
    limits: &Limits,
    models: Option<&OpenRouterModels>,
    reserve: u64,
    decided: &str,
) -> Served {
    if !limits.fixed && !limits.no_swap {
        let band = tiers.band(decided);
        if let Some(to) = swap_target(tiers, limits, models, reserve, band) {
            return Served {
                model: tiers.slug(to),
                decided_tier: Some(band.to_string()),
            };
        }
    }
    Served {
        model: decided.to_string(),
        decided_tier: None,
    }
}

fn served_tier_before(
    tiers: &Tiers,
    limits: &Limits,
    models: Option<&OpenRouterModels>,
    reserve: u64,
    tier_before: &str,
) -> String {
    if limits.fixed {
        return tier_before.to_string();
    }
    swap_target(tiers, limits, models, reserve, tier_before)
        .unwrap_or(tier_before)
        .to_string()
}

pub(super) struct RoutePlan {
    pub model: String,
    pub tools: Vec<String>,
    pub reason: Option<String>,
    pub tier_before: String,
    pub reserve: u64,
    pub allow_compact: bool,
    pub persist: bool,
    pub sticky_band: String,
    pub escalate_remaining: u32,
    pub escalate_band: Option<String>,
    pub last_stall: Option<String>,
    pub pending_down_band: Option<String>,
    pub down_count: u32,
    pub trimmed_from_tokens: Option<u64>,
    pub spent_micros: u64,
    pub limits: super::Limits,
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
    pub decided_tier: Option<String>,
    pub models: Option<&'a OpenRouterModels>,
    pub limits: &'a Limits,
}

pub(super) fn run(ctx: RouteCtx<'_>) -> Turn {
    let mut plan = ctx.plan;
    if plan.model.is_empty() {
        plan.model = ctx.auto.tiers.mid.clone();
    }
    let mut served = serve(
        &ctx.auto.tiers,
        &plan.limits,
        ctx.models,
        plan.reserve,
        &plan.model,
    );
    let previous_served = ctx.previous_model.as_deref().map(|model| {
        serve(
            &ctx.auto.tiers,
            &plan.limits,
            ctx.models,
            plan.reserve,
            model,
        )
        .model
    });
    let previous = previous_served.as_deref();
    let mut shaped_out = shaped(ShapeArgs {
        body: &ctx.body,
        model: &served.model,
        previous_model: previous,
        models: ctx.models,
        provider_order: &ctx.auto.tiers.provider_order,
        allow_fallbacks: ctx.auto.tiers.allow_fallbacks,
        strip_fields: &ctx.auto.tiers.strip_fields,
        require_parameters: ctx.auto.tiers.require_parameters,
        default_max_tokens: ctx.auto.tiers.default_max_tokens,
    });
    let mut outgoing = shaped_out.body;
    if let Some(window) = catalog::context_length(ctx.models, &served.model) {
        let estimate = context_estimate(counted_bytes(&outgoing), window, plan.reserve);
        tracing::debug!(
            input_tokens_est = estimate.input_tokens_est,
            fill = estimate.fill,
            "autoroute"
        );
        if estimate.fill < metrics::FILL_THRESHOLD && estimate.usable >= 1024 {
            if let Some(id) = body::session_key(&ctx.body) {
                ctx.auto.rearm_compaction(&id);
            }
        }
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
            if skips_fill_upgrade(plan.reason.as_deref()) {
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
            let need = estimate.input_tokens_est.saturating_mul(4) / 3 + 1;
            let tiers: Vec<&str> = ctx
                .auto
                .tiers
                .candidates()
                .into_iter()
                .filter(|slug| match plan.limits.max_band {
                    Some(max) => {
                        catalog::band_rank(ctx.auto.tiers.band(slug)) <= catalog::band_rank(max)
                    }
                    None => true,
                })
                .collect();
            if let Some(slug) = catalog::larger_fit(LargerFit {
                candidates: &tiers,
                models: ctx.models,
                input_tokens: need,
                max_tokens: plan.reserve,
                current: &served.model,
            }) {
                plan.model = slug;
                let mut upgraded = StickyOutcome {
                    model: plan.model.clone(),
                    sticky_band: plan.sticky_band.clone(),
                    escalate_remaining: plan.escalate_remaining,
                    escalate_band: plan.escalate_band.clone(),
                    last_stall: plan.last_stall.clone(),
                    pending_down_band: plan.pending_down_band.clone(),
                    down_count: plan.down_count,
                    reason: Some("upgrade".to_string()),
                };
                cap_for_budget_with(
                    &mut upgraded,
                    &ctx.auto.tiers,
                    plan.limits.budget_micros,
                    plan.spent_micros,
                    RequestShape {
                        input_tokens: estimate.input_tokens_est,
                        output_tokens: plan.reserve.min(1024),
                    },
                );
                plan.model = upgraded.model;
                plan.sticky_band = upgraded.sticky_band;
                plan.reason = upgraded.reason;
                if plan.reason.as_deref() == Some("upgrade") {
                    // the upgrade picked this model for its window; the price rule must not swap it back
                    plan.limits.no_swap = true;
                }
                served = serve(
                    &ctx.auto.tiers,
                    &plan.limits,
                    ctx.models,
                    plan.reserve,
                    &plan.model,
                );
                let grew = catalog::context_length(ctx.models, &served.model)
                    .is_some_and(|next| next > window);
                if !grew {
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
                shaped_out = shaped(ShapeArgs {
                    body: &ctx.body,
                    model: &served.model,
                    previous_model: previous,
                    models: ctx.models,
                    provider_order: &ctx.auto.tiers.provider_order,
                    allow_fallbacks: ctx.auto.tiers.allow_fallbacks,
                    strip_fields: &ctx.auto.tiers.strip_fields,
                    require_parameters: ctx.auto.tiers.require_parameters,
                    default_max_tokens: ctx.auto.tiers.default_max_tokens,
                });
                outgoing = shaped_out.body.clone();
                if let Some(next_window) = catalog::context_length(ctx.models, &served.model) {
                    let again =
                        context_estimate(counted_bytes(&outgoing), next_window, plan.reserve);
                    if again.usable < 1024 || again.fill >= metrics::FILL_THRESHOLD {
                        return finish_overflow(OverflowCtx {
                            auto: ctx.auto,
                            body: &ctx.body,
                            outgoing: &outgoing,
                            models: ctx.models,
                            previous_model: previous,
                            input_tokens_est: again.input_tokens_est,
                            plan,
                        });
                    }
                }
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
    } else {
        tracing::debug!(model = %served.model, "autoroute catalog miss; skip fill/compact");
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
    let tier_after = ctx.auto.tiers().band(&served.model).to_string();
    let tier_before = served_tier_before(
        &ctx.auto.tiers,
        &plan.limits,
        ctx.models,
        plan.reserve,
        &plan.tier_before,
    );
    let meta = RouteMeta::from_plan(tier_before, tier_after, plan.reason.as_deref())
        .with_stripped(&shaped_out.stripped)
        .with_decided_tier(served.decided_tier);
    encode_forward(&outgoing, meta, plan.trimmed_from_tokens)
}

fn skips_fill_upgrade(reason: Option<&str>) -> bool {
    matches!(
        reason,
        Some("housekeeping" | "housekeeping_trimmed" | "permission_check" | "background_model")
    )
}

fn finish_overflow(ctx: OverflowCtx<'_>) -> Turn {
    let plan = ctx.plan;
    let served = serve(
        &ctx.auto.tiers,
        &plan.limits,
        ctx.models,
        plan.reserve,
        &plan.model,
    );
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
            model: &served.model,
            decided_tier: served.decided_tier,
            previous_model: ctx.previous_model,
            models: ctx.models,
            reason: plan.reason,
            tier_before: served_tier_before(
                &ctx.auto.tiers,
                &plan.limits,
                ctx.models,
                plan.reserve,
                &plan.tier_before,
            ),
            auto: ctx.auto,
            trimmed_from_tokens: plan.trimmed_from_tokens,
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
        model: &served.model,
        decided_tier: served.decided_tier,
        models: ctx.models,
        limits: &plan.limits,
    })
}

pub(super) struct ShapedForward<'a> {
    pub body: &'a Value,
    pub model: &'a str,
    pub decided_tier: Option<String>,
    pub previous_model: Option<&'a str>,
    pub models: Option<&'a OpenRouterModels>,
    pub reason: Option<String>,
    pub tier_before: String,
    pub auto: &'a Auto,
    pub trimmed_from_tokens: Option<u64>,
}

pub(super) fn forward_shaped(plan: ShapedForward<'_>) -> Turn {
    let tier_after = plan.auto.tiers().band(plan.model).to_string();
    let shaped_out = shaped(ShapeArgs {
        body: plan.body,
        model: plan.model,
        previous_model: plan.previous_model,
        models: plan.models,
        provider_order: &plan.auto.tiers.provider_order,
        allow_fallbacks: plan.auto.tiers.allow_fallbacks,
        strip_fields: &plan.auto.tiers.strip_fields,
        require_parameters: plan.auto.tiers.require_parameters,
        default_max_tokens: plan.auto.tiers.default_max_tokens,
    });
    let meta = RouteMeta::from_plan(plan.tier_before, tier_after, plan.reason.as_deref())
        .with_stripped(&shaped_out.stripped)
        .with_decided_tier(plan.decided_tier);
    encode_forward(&shaped_out.body, meta, plan.trimmed_from_tokens)
}

pub(super) struct Passthrough<'a> {
    pub auto: &'a Auto,
    pub body: &'a Value,
    pub models: Option<&'a OpenRouterModels>,
}

pub(super) fn passthrough(plan: Passthrough<'_>) -> Turn {
    let model = plan.body.get("model").and_then(Value::as_str).unwrap_or("");
    let shaped_out = shaped(ShapeArgs {
        body: plan.body,
        model,
        previous_model: Some(model),
        models: plan.models,
        provider_order: &plan.auto.tiers.provider_order,
        allow_fallbacks: plan.auto.tiers.allow_fallbacks,
        strip_fields: &plan.auto.tiers.strip_fields,
        require_parameters: plan.auto.tiers.require_parameters,
        default_max_tokens: plan.auto.tiers.default_max_tokens,
    });
    let meta = RouteMeta::from_plan("unset".to_string(), "unset".to_string(), None)
        .with_stripped(&shaped_out.stripped);
    encode_forward(&shaped_out.body, meta, None)
}

pub(super) fn repeat_compact(plan: RepeatCompact<'_>) -> Turn {
    let fallback = catalog::context_length(plan.models, plan.model)
        .filter(|_| !plan.limits.fixed)
        .and_then(|current_window| {
            plan.auto
                .tiers
                .candidates()
                .into_iter()
                .filter_map(|slug| {
                    if catalog::ids_match(slug, plan.model) {
                        return None;
                    }
                    if let Some(max) = plan.limits.max_band {
                        if catalog::band_rank(plan.auto.tiers.band(slug)) > catalog::band_rank(max)
                        {
                            return None;
                        }
                    }
                    let window = catalog::context_length(plan.models, slug)?;
                    (window > current_window).then_some((window, slug))
                })
                .min_by_key(|(window, _)| *window)
                .map(|(_, slug)| slug)
        });
    match serde_json::to_vec(&compaction_body(plan.body, plan.model)) {
        Ok(body) => Turn::Compact(Compact {
            body,
            model: plan.model.to_string(),
            fallback_model: fallback.map(str::to_string),
            decided_tier: plan.decided_tier,
        }),
        Err(err) => {
            tracing::error!(%err, "autoroute compact encode failed");
            passthrough(Passthrough {
                auto: plan.auto,
                body: plan.body,
                models: plan.models,
            })
        }
    }
}

struct ShapeArgs<'a> {
    body: &'a Value,
    model: &'a str,
    previous_model: Option<&'a str>,
    models: Option<&'a OpenRouterModels>,
    provider_order: &'a [String],
    allow_fallbacks: bool,
    strip_fields: &'a [String],
    require_parameters: catalog::RequireParameters,
    default_max_tokens: u64,
}

fn shaped(plan: ShapeArgs<'_>) -> body::ShapeResult {
    body::shape(ShapePlan {
        body: plan.body,
        model: plan.model,
        previous_model: plan.previous_model,
        models: plan.models,
        provider_order: plan.provider_order,
        allow_fallbacks: plan.allow_fallbacks,
        strip_fields: plan.strip_fields,
        require_parameters: plan.require_parameters,
        default_max_tokens: plan.default_max_tokens,
    })
}

fn remember(plan: RememberPlan<'_>) {
    let Some(id) = body::session_key(plan.body) else {
        return;
    };
    let Ok(mut sessions) = plan.auto.sessions.lock() else {
        return;
    };
    let existing = sessions.get(&id);
    let cost_micros = existing.as_ref().map(|row| row.cost_micros).unwrap_or(0);
    let compact_suppressed = existing.as_ref().is_some_and(|row| row.compact_suppressed);
    let compact_suppressed_requests = existing
        .as_ref()
        .map(|row| row.compact_suppressed_requests)
        .unwrap_or(0);
    sessions.insert(
        id,
        SessionChoice {
            model: plan.model.to_string(),
            tools: plan.tools.to_vec(),
            prev_input_tokens_est: plan.prev_input_tokens_est,
            awaiting_compact: plan.awaiting_compact,
            compact_issued: plan.awaiting_compact,
            compact_suppressed,
            compact_suppressed_requests,
            seen: Instant::now(),
            sticky_band: plan.sticky_band.to_string(),
            escalate_remaining: plan.escalate_remaining,
            escalate_band: plan.escalate_band.map(str::to_string),
            last_stall: plan.last_stall.map(str::to_string),
            pending_down_band: plan.pending_down_band.map(str::to_string),
            down_count: plan.down_count,
            cost_micros,
        },
    );
}

fn encode_forward(body: &Value, meta: RouteMeta, trimmed_from_tokens: Option<u64>) -> Turn {
    match serde_json::to_vec(body) {
        Ok(bytes) => Turn::Forward(Forward {
            body: bytes,
            meta,
            trimmed_from_tokens,
        }),
        Err(err) => {
            tracing::error!(%err, "autoroute encode failed");
            Turn::Forward(Forward {
                body: Vec::new(),
                meta: RouteMeta::from_plan("unset".to_string(), "unset".to_string(), None),
                trimmed_from_tokens: None,
            })
        }
    }
}
