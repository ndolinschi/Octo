use super::super::catalog::{self, Tiers};
use super::super::jev::Complexity;
use super::super::session::SessionChoice;
use super::super::stall::StallTrigger;

pub struct StickyPlan<'a> {
    pub tiers: &'a Tiers,
    pub choice: Option<&'a SessionChoice>,
    pub classified: Complexity,
    pub preferred: Option<&'a str>,
    pub stall: Option<StallTrigger>,
    pub tool_results_only: bool,
}

pub struct StickyOutcome {
    pub model: String,
    pub sticky_band: String,
    pub escalate_remaining: u32,
    pub escalate_band: Option<String>,
    pub last_stall: Option<String>,
    pub pending_down_band: Option<String>,
    pub down_count: u32,
    pub reason: Option<String>,
}

pub fn apply(plan: StickyPlan<'_>) -> StickyOutcome {
    let classified_band = catalog::complexity_band(plan.classified).to_string();
    let mut sticky_band = plan
        .choice
        .map(|row| row.sticky_band.clone())
        .unwrap_or_else(|| classified_band.clone());
    let mut pending_down_band = plan.choice.and_then(|row| row.pending_down_band.clone());
    let mut down_count = plan.choice.map(|row| row.down_count).unwrap_or(0);
    let mut reason = None;

    let classified_rank = catalog::band_rank(&classified_band);
    let sticky_rank = catalog::band_rank(&sticky_band);
    if classified_rank > sticky_rank {
        sticky_band = classified_band.clone();
        pending_down_band = None;
        down_count = 0;
    } else if classified_rank < sticky_rank {
        if pending_down_band.as_deref() == Some(classified_band.as_str()) {
            down_count = down_count.saturating_add(1);
        } else {
            pending_down_band = Some(classified_band.clone());
            down_count = 1;
        }
        if down_count >= plan.tiers.down_confirm {
            sticky_band = classified_band.clone();
            pending_down_band = None;
            down_count = 0;
        } else {
            reason = Some("hysteresis_hold".to_string());
        }
    } else {
        pending_down_band = None;
        down_count = 0;
    }

    let mut escalate_remaining = plan.choice.map(|row| row.escalate_remaining).unwrap_or(0);
    let mut escalate_band = plan.choice.and_then(|row| row.escalate_band.clone());
    let mut last_stall = plan.choice.and_then(|row| row.last_stall.clone());

    if let Some(trigger) = plan.stall {
        let base = if escalate_band.is_some() && escalate_remaining > 0 {
            escalate_band.clone().unwrap_or_else(|| sticky_band.clone())
        } else {
            sticky_band.clone()
        };
        let next = catalog::bump_band(&base).to_string();
        escalate_band = Some(next.clone());
        escalate_remaining = plan.tiers.escalate_turns;
        last_stall = Some(trigger.as_str().to_string());
        let live = higher_band(&next, &sticky_band);
        reason = Some(format!("stall_escalate:{}", trigger.as_str()));
        return StickyOutcome {
            model: plan.tiers.slug(live),
            sticky_band,
            escalate_remaining,
            escalate_band,
            last_stall,
            pending_down_band,
            down_count,
            reason,
        };
    }

    if plan.tool_results_only {
        if let Some(row) = plan.choice {
            return StickyOutcome {
                model: row.model.clone(),
                sticky_band: row.sticky_band.clone(),
                escalate_remaining: row.escalate_remaining,
                escalate_band: row.escalate_band.clone(),
                last_stall: row.last_stall.clone(),
                pending_down_band: row.pending_down_band.clone(),
                down_count: row.down_count,
                reason: None,
            };
        }
    }

    if escalate_remaining > 0 {
        escalate_remaining -= 1;
        if escalate_remaining == 0 {
            escalate_band = None;
            reason = Some("stall_release".to_string());
            return StickyOutcome {
                model: plan.tiers.pick(plan.classified, plan.preferred),
                sticky_band,
                escalate_remaining,
                escalate_band,
                last_stall,
                pending_down_band,
                down_count,
                reason,
            };
        }
        let escalate = escalate_band
            .clone()
            .unwrap_or_else(|| catalog::bump_band(&sticky_band).to_string());
        let live = higher_band(&escalate, &sticky_band).to_string();
        if reason.as_deref() == Some("hysteresis_hold")
            || catalog::band_rank(&sticky_band) > catalog::band_rank(&escalate)
        {
            reason = None;
        }
        return StickyOutcome {
            model: plan.tiers.slug(&live),
            sticky_band,
            escalate_remaining,
            escalate_band: Some(escalate),
            last_stall,
            pending_down_band,
            down_count,
            reason,
        };
    }

    let model = if reason.as_deref() == Some("hysteresis_hold") {
        plan.tiers.slug(&sticky_band)
    } else {
        plan.tiers.pick(plan.classified, plan.preferred)
    };
    StickyOutcome {
        model,
        sticky_band,
        escalate_remaining: 0,
        escalate_band: None,
        last_stall,
        pending_down_band,
        down_count,
        reason,
    }
}

pub fn cap_for_budget(out: &mut StickyOutcome, tiers: &Tiers, spent_micros: u64) {
    if tiers.session_budget_micros == 0 || spent_micros < tiers.session_budget_micros {
        return;
    }
    let mid_rank = catalog::band_rank("mid");
    if catalog::band_rank(&out.sticky_band) > mid_rank {
        out.sticky_band = "mid".to_string();
        out.model = tiers.slug("mid");
        out.reason = Some("budget_cap".to_string());
        return;
    }
    if catalog::band_rank(tiers.band(&out.model)) > mid_rank {
        out.model = tiers.slug("mid");
        out.reason = Some("budget_cap".to_string());
    }
}

fn higher_band<'a>(left: &'a str, right: &'a str) -> &'a str {
    if catalog::band_rank(left) >= catalog::band_rank(right) {
        left
    } else {
        right
    }
}
