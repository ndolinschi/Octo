use std::collections::HashSet;
use std::time::Duration;

use reqwest::Client;
use serde_json::json;

use crate::auto::calls::{CallRow, PersistedCall, RouteRecord};
use crate::auto::decide::classify::{bump_tool_inspection_off_easy, record, RecordPlan};
use crate::auto::{body, jev, new_request_id, valid_budget_key, Auto, Hints, Reject};
use crate::history::{usage_from_output, History};

use super::band;
use super::policy::{
    api_swap, estimate_usd, select, select_after_budget, How, RoutePolicy, Selection,
};
use super::types::{Alternative, Band, Candidate, RouteRequest, RouteResponse};

pub struct RouteInput<'a> {
    pub auto: &'a Auto,
    pub history: &'a History,
    pub client: &'a Client,
    pub decisions_url: &'a str,
    pub api_key: &'a str,
}

#[derive(Debug)]
pub enum RouteError {
    Invalid(String),
    Budget(Reject),
}

enum Classification {
    Used,
    NotUsed(&'static str),
    BudgetReached,
}

struct Classified {
    band: Band,
    how: Classification,
    cost_micros: u64,
    cost_source: &'static str,
    input_tokens: u64,
    output_tokens: u64,
}

pub async fn route(
    input: RouteInput<'_>,
    request: RouteRequest,
) -> Result<RouteResponse, RouteError> {
    validate(&request)?;
    let auto = input.auto;
    let tiers = auto.tiers();
    let policy = &tiers.route;
    let key = request.budget_key.clone();
    auto.restore_budget_key(input.history, &key).await;
    auto.bind_hints(
        None,
        &Hints {
            budget_key: Some(key.clone()),
            ..Hints::default()
        },
    );
    let text = task_text(&request);
    let facts = jev::inspect(
        &json!({"messages": [{"role": "user", "content": text}]}),
        &text,
    );
    let budget = auto.effective_budget(Some(&key));
    let spent = auto.budget_spent(&key);
    let reached = budget.micros > 0 && spent >= budget.micros;
    let candidates = &request.candidates;

    let (classified, selection) = if reached {
        let band = band::fallback(&facts, &text, candidates);
        let allow_api = budget.action == crate::auto::BudgetAction::Downgrade;
        let selection = select_after_budget(tiers, policy, band, candidates, allow_api)
            .ok_or_else(|| {
                RouteError::Budget(Reject {
                    budget_micros: budget.micros,
                    spent_micros: spent,
                    budget_key: Some(key.clone()),
                })
            })?;
        (
            Classified {
                band,
                how: Classification::BudgetReached,
                cost_micros: 0,
                cost_source: "estimated",
                input_tokens: 0,
                output_tokens: 0,
            },
            selection,
        )
    } else {
        let classified = classify(&input, &request, &text, &facts, policy).await;
        let selection = select(tiers, policy, classified.band, candidates)
            .ok_or_else(|| RouteError::Invalid("no usable candidate".to_string()))?;
        (classified, selection)
    };
    let spent_after = auto.charge(input.history, None, Some(&key), classified.cost_micros);

    let chosen = &candidates[selection.index];
    let swap = match chosen {
        Candidate::Api { tier, .. } => api_swap(tiers, policy, candidates, *tier),
        Candidate::Agent { .. } => None,
    };
    let reason = reason(&ReasonPlan {
        band: classified.band,
        classification: &classified.how,
        how: selection.how,
        chosen,
        budget: (budget.micros, spent),
        swap: swap.map(|served| (served, tiers.slug(served))),
    });
    let request_id = new_request_id();
    let (model, tier, decided_tier) = match chosen {
        Candidate::Api { tier, .. } => {
            let decided = tier.ladder_band();
            let served = swap.unwrap_or(decided);
            (
                Some(tiers.slug(served)),
                served.to_string(),
                swap.map(|_| decided.to_string()),
            )
        }
        Candidate::Agent { .. } => (None, "agent".to_string(), None),
    };
    let row = CallRow {
        model: model.clone().unwrap_or_else(|| chosen.id().to_string()),
        tier,
        decided_tier,
        trigger: "route".to_string(),
        input_tokens: classified.input_tokens,
        output_tokens: classified.output_tokens,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        cost_usd: classified.cost_micros as f64 / 1_000_000.0,
        cost_source: classified.cost_source,
        estimate_ratio: None,
        upstream_id: None,
        spent_after_usd: spent_after.map(crate::auto::micros_usd),
        route: Some(RouteRecord {
            choice: chosen.id().to_string(),
            band: classified.band.as_str(),
            reason: reason.clone(),
            classifier: match classified.how {
                Classification::Used => "used",
                Classification::NotUsed(_) => "fallback",
                Classification::BudgetReached => "skipped",
            },
            depth: request.task.depth,
            budget_key: key.clone(),
        }),
    };
    auto.record_call_persisted(
        input.history,
        PersistedCall {
            request_id: request_id.clone(),
            session_id: None,
            budget_key: Some(key),
            row,
        },
    );
    Ok(RouteResponse {
        choice: chosen.id().to_string(),
        model,
        band: classified.band,
        reason,
        estimated_cost_usd: estimate_usd(tiers, policy, candidates, chosen),
        alternatives: alternatives(auto, policy, candidates, &selection),
        request_id,
    })
}

fn alternatives(
    auto: &Auto,
    policy: &RoutePolicy,
    candidates: &[Candidate],
    selection: &Selection,
) -> Vec<Alternative> {
    selection
        .alternatives
        .iter()
        .map(|&index| Alternative {
            id: candidates[index].id().to_string(),
            estimated_cost_usd: estimate_usd(auto.tiers(), policy, candidates, &candidates[index]),
        })
        .collect()
}

fn validate(request: &RouteRequest) -> Result<(), RouteError> {
    let invalid = |message: &str| Err(RouteError::Invalid(message.to_string()));
    if !valid_budget_key(&request.budget_key) {
        return invalid("budget_key must be 1 to 128 printable ASCII characters");
    }
    if request.task.title.trim().is_empty() && request.task.brief.trim().is_empty() {
        return invalid("task needs a title or a brief");
    }
    if request.candidates.is_empty() {
        return invalid("candidates must not be empty");
    }
    let mut seen = HashSet::new();
    for candidate in &request.candidates {
        if candidate.id().trim().is_empty() {
            return invalid("every candidate needs a non-empty id");
        }
        if !seen.insert(candidate.id()) {
            return invalid("candidate ids must be unique");
        }
    }
    if !request.candidates.iter().any(Candidate::usable) {
        return invalid(
            "no usable candidate: every agent is logged out or out of limit and no API candidate was offered",
        );
    }
    Ok(())
}

fn task_text(request: &RouteRequest) -> String {
    let title = request.task.title.trim();
    let brief = request.task.brief.trim();
    match (title.is_empty(), brief.is_empty()) {
        (_, true) => title.to_string(),
        (true, false) => brief.to_string(),
        (false, false) => format!("{title}\n\n{brief}"),
    }
}

async fn classify(
    input: &RouteInput<'_>,
    request: &RouteRequest,
    text: &str,
    facts: &jev::ContextFacts,
    policy: &RoutePolicy,
) -> Classified {
    let fallback = |why: &'static str| Classified {
        band: band::fallback(facts, text, &request.candidates),
        how: Classification::NotUsed(why),
        cost_micros: 0,
        cost_source: "estimated",
        input_tokens: 0,
        output_tokens: 0,
    };
    if input.api_key.is_empty() {
        return fallback("no API key");
    }
    if policy.classifier_timeout_ms == 0 {
        return fallback("disabled");
    }
    let tiers = input.auto.tiers();
    let capped = body::cap_classifier_text(text);
    let asked = tokio::time::timeout(
        Duration::from_millis(policy.classifier_timeout_ms),
        jev::classify(jev::ClassifyRequest {
            client: input.client,
            decisions_url: input.decisions_url,
            api_key: input.api_key,
            user_text: &capped,
            tool_names: &request.task.tools,
            current_tools: &[],
            facts,
            current_tier: "unset",
            thresholds: jev::Thresholds {
                hard: tiers.hard_threshold,
                easy: tiers.easy_threshold,
            },
        }),
    )
    .await;
    let Ok(asked) = asked else {
        return fallback("timed out");
    };
    let recorded = record(RecordPlan {
        auto: input.auto,
        history: input.history,
        session_id: None,
        purpose: "route",
        asked: &asked,
    });
    let usage = usage_from_output(&asked.response_body);
    let cost_micros = recorded.cost.map_or(0, |cost| cost.0);
    let Some(parsed) = asked.parsed else {
        let mut failed = fallback("call failed");
        failed.cost_micros = cost_micros;
        failed.cost_source = recorded.cost_source;
        return failed;
    };
    let complexity = bump_tool_inspection_off_easy(parsed.complexity, &request.task.tools, text);
    Classified {
        band: Band::from_complexity(complexity),
        how: Classification::Used,
        cost_micros,
        cost_source: recorded.cost_source,
        input_tokens: usage.input_tokens.map_or(0, |t| t.0),
        output_tokens: usage.output_tokens.map_or(0, |t| t.0),
    }
}

struct ReasonPlan<'a> {
    band: Band,
    classification: &'a Classification,
    how: How,
    chosen: &'a Candidate,
    budget: (u64, u64),
    swap: Option<(&'static str, String)>,
}

fn reason(plan: &ReasonPlan<'_>) -> String {
    let name = match plan.chosen {
        Candidate::Agent { label, id, .. } if !label.trim().is_empty() => {
            format!("{} ({id})", label.trim())
        }
        other => other.id().to_string(),
    };
    let tier = match plan.chosen {
        Candidate::Api { tier, .. } => tier.as_str(),
        Candidate::Agent { .. } => "",
    };
    let lead = match plan.classification {
        Classification::Used => format!("{} task", plan.band.as_str()),
        Classification::NotUsed(why) => format!(
            "{} task estimated from its text (classifier not used: {why})",
            plan.band.as_str()
        ),
        Classification::BudgetReached => format!(
            "Budget reached (${:.4} of ${:.4}, classifier not called)",
            plan.budget.1 as f64 / 1_000_000.0,
            plan.budget.0 as f64 / 1_000_000.0
        ),
    };
    let lead = capitalize(&lead);
    let swap_note = match (plan.chosen, &plan.swap) {
        (Candidate::Api { tier, .. }, Some((served, slug))) => format!(
            " Price rule: the {} tier would be served by the {served} tier model {slug}, which is cheaper for this request.",
            tier.as_str()
        ),
        _ => String::new(),
    };
    let rest = match plan.how {
        How::FlatAgent => format!("{name} is flat-rate and logged in, so it adds no API cost"),
        How::Api => format!("the {tier} API tier is the cheapest able to do it"),
        How::PaidAgent => format!("{name} can do it and nothing cheaper was able"),
        How::FallbackApi => format!(
            "no candidate was rated for it, so the highest API tier offered ({tier}) is used"
        ),
        How::FallbackAgent => {
            format!("no candidate was rated for it, so the first logged-in agent {name} is used")
        }
        How::BudgetAgent => format!("flat-rate agent {name} is used"),
        How::BudgetApi => format!("the cheapest API tier offered ({tier}) is used"),
    };
    format!("{lead}; {rest}.{swap_note}")
}

fn capitalize(text: &str) -> String {
    let mut chars = text.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    }
}
