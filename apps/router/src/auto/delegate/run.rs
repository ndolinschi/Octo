use std::collections::HashSet;
use std::time::Duration;

use reqwest::Client;
use serde_json::json;

use crate::auto::calls::{CallRow, PersistedCall, RouteRecord};
use crate::auto::decide::classify::{bump_tool_inspection_off_easy, record, RecordPlan};
use crate::auto::{body, jev, new_request_id, valid_budget_key, Auto, Hints, Reject};
use crate::history::{usage_from_output, DelegationInsert, History};

use super::band::{has_hard_keyword, read_only, HeuristicInput};
use super::classifier::{DelegationClassifier, Verdict, VerdictStatus, JEV_VERSION};
use super::policy::{
    api_swap, estimate_usd, select, select_after_budget, How, RoutePolicy, Selection,
};
use super::types::{Alternative, ApiTier, Band, Candidate, RouteRequest, RouteResponse};

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

pub async fn route(
    input: RouteInput<'_>,
    mut request: RouteRequest,
) -> Result<RouteResponse, RouteError> {
    validate(&request)?;
    narrow(&mut request)?;
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
    let heuristic_input = HeuristicInput {
        facts: &facts,
        text: &text,
        tools: &request.task.tools,
        depth: request.task.depth,
        candidates,
    };
    let floor = request.min_tier.map(ApiTier::band);
    let raise = |mut verdict: Verdict| {
        if let Some(floor) = floor {
            if floor.rank() > verdict.band.rank() {
                verdict.band = floor;
            }
        }
        verdict
    };

    let (verdict, selection) = if reached {
        let verdict = raise(Verdict::heuristic(
            &heuristic_input,
            tiers.delegation.name(),
            VerdictStatus::Skipped,
        ));
        let allow_api = budget.action == crate::auto::BudgetAction::Downgrade;
        let selection = select_after_budget(tiers, policy, verdict.band, candidates, allow_api)
            .ok_or_else(|| {
                RouteError::Budget(Reject {
                    budget_micros: budget.micros,
                    spent_micros: spent,
                    budget_key: Some(key.clone()),
                    from_header: budget.from_header,
                })
            })?;
        (verdict, selection)
    } else {
        let verdict = raise(classify(&input, &request, &text, &facts, &heuristic_input).await);
        let selection = select(tiers, policy, verdict.band, candidates)
            .ok_or_else(|| RouteError::Invalid("no usable candidate".to_string()))?;
        (verdict, selection)
    };
    let spent_after = auto.charge(input.history, None, Some(&key), verdict.cost_micros);

    let chosen = &candidates[selection.index];
    let swap = match chosen {
        Candidate::Api { tier, .. } => api_swap(tiers, policy, candidates, *tier),
        Candidate::Agent { .. } => None,
    };
    let reason = reason(&ReasonPlan {
        verdict: &verdict,
        how: selection.how,
        chosen,
        budget: (budget.micros, spent),
        swap: swap.map(|served| (served, tiers.slug(served))),
        floor,
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
    let attempt = request.attempt.unwrap_or(1).max(1);
    let estimated = estimate_usd(tiers, policy, candidates, chosen);
    let fallback_reason = verdict.status.fallback_reason().map(str::to_string);
    let row = CallRow {
        model: model.clone().unwrap_or_else(|| chosen.id().to_string()),
        tier: tier.clone(),
        decided_tier,
        trigger: "route".to_string(),
        input_tokens: verdict.input_tokens,
        output_tokens: verdict.output_tokens,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        cost_usd: verdict.cost_micros as f64 / 1_000_000.0,
        cost_source: verdict.cost_source,
        estimate_ratio: None,
        price_source: None,
        upstream_id: None,
        spent_after_usd: spent_after.map(crate::auto::micros_usd),
        route: Some(RouteRecord {
            choice: chosen.id().to_string(),
            band: verdict.band.as_str(),
            reason: reason.clone(),
            classifier: verdict.status.as_str(),
            depth: request.task.depth,
            budget_key: key.clone(),
            decided_by: Some(verdict.decided_by),
            fallback_reason: fallback_reason.clone(),
            attempt: (attempt > 1).then_some(attempt),
        }),
    };
    auto.record_call_persisted(
        input.history,
        PersistedCall {
            request_id: request_id.clone(),
            session_id: None,
            budget_key: Some(key.clone()),
            row,
        },
    );
    input.history.record_delegation(DelegationInsert {
        request_id: request_id.clone(),
        budget_key: key,
        session_id: request.session_id.clone(),
        attempt,
        escalated_from: request.escalated_from.clone(),
        title: request.task.title.clone(),
        brief: request.task.brief.clone(),
        text_features: json!({
            "multiple_files": facts.mentions_multiple_files,
            "tests": facts.mentions_tests,
            "stack_trace": facts.mentions_stack_trace,
            "hard_keyword": has_hard_keyword(&text),
            "asks_inspection": jev::asks_file_or_repo_inspection(&text),
            "read_only_tools": read_only(&request.task.tools),
            "text_chars": text.chars().count(),
        }),
        tools: request.task.tools.clone(),
        depth: request.task.depth,
        parent_tier: request.task.parent_tier.clone(),
        candidates: serde_json::to_value(candidates).unwrap_or_default(),
        exclude: request.exclude.clone(),
        min_tier: request.min_tier.map(|tier| tier.as_str().to_string()),
        choice: chosen.id().to_string(),
        choice_kind: match chosen {
            Candidate::Api { .. } => "api",
            Candidate::Agent { .. } => "agent",
        },
        choice_tier: match chosen {
            Candidate::Api { tier, .. } => Some(tier.as_str().to_string()),
            Candidate::Agent { .. } => None,
        },
        model: model.clone(),
        served_tier: tier,
        band: verdict.band.as_str().to_string(),
        reason: reason.clone(),
        classifier: verdict.decided_by.to_string(),
        classifier_requested: verdict.requested.to_string(),
        classifier_version: verdict.version.to_string(),
        classifier_status: verdict.status.as_str().to_string(),
        fallback_reason,
        probabilities: verdict.probabilities,
        estimated_cost_micros: estimated.map(|usd| (usd * 1_000_000.0).round() as u64),
        classifier_cost_micros: verdict.cost_micros,
    });
    Ok(RouteResponse {
        choice: chosen.id().to_string(),
        model,
        band: verdict.band,
        reason,
        estimated_cost_usd: estimated,
        alternatives: alternatives(auto, policy, candidates, &selection),
        request_id,
        classifier: verdict.decided_by,
        attempt,
    })
}

/// Applies `exclude` and `min_tier`: excluded ids and API tiers below the floor are not offered at all.
fn narrow(request: &mut RouteRequest) -> Result<(), RouteError> {
    if request.exclude.is_empty() && request.min_tier.is_none() {
        return Ok(());
    }
    let floor = request.min_tier.map_or(0, ApiTier::rank);
    let exclude = request.exclude.clone();
    request.candidates.retain(|candidate| {
        !exclude.iter().any(|id| id == candidate.id())
            && match candidate {
                Candidate::Api { tier, .. } => tier.rank() >= floor,
                Candidate::Agent { .. } => true,
            }
    });
    if !request.candidates.iter().any(Candidate::usable) {
        return Err(RouteError::Invalid(
            "no usable candidate left after exclude and min_tier".to_string(),
        ));
    }
    Ok(())
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
    if let Some(id) = &request.escalated_from {
        if id.is_empty() || id.len() > 128 || !id.chars().all(|c| c.is_ascii_graphic()) {
            return invalid("escalated_from must be a request id");
        }
    }
    if let Some(session) = &request.session_id {
        if session.len() > 256 || session.chars().any(char::is_control) {
            return invalid("session_id must be at most 256 characters");
        }
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
    heuristic_input: &HeuristicInput<'_>,
) -> Verdict {
    match &input.auto.tiers().delegation {
        DelegationClassifier::Heuristic => {
            Verdict::heuristic(heuristic_input, "heuristic", VerdictStatus::Used)
        }
        DelegationClassifier::Learned { model_path } => Verdict::heuristic(
            heuristic_input,
            "learned",
            VerdictStatus::Fallback(DelegationClassifier::learned_unavailable(model_path)),
        ),
        DelegationClassifier::Jev => {
            jev_verdict(input, request, text, facts, heuristic_input).await
        }
    }
}

async fn jev_verdict(
    input: &RouteInput<'_>,
    request: &RouteRequest,
    text: &str,
    facts: &jev::ContextFacts,
    heuristic_input: &HeuristicInput<'_>,
) -> Verdict {
    let fallback = |why: &str| {
        Verdict::heuristic(
            heuristic_input,
            "jev",
            VerdictStatus::Fallback(why.to_string()),
        )
    };
    let tiers = input.auto.tiers();
    let policy = &tiers.route;
    if input.api_key.is_empty() {
        return fallback("no API key");
    }
    if policy.classifier_timeout_ms == 0 {
        return fallback("disabled");
    }
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
    Verdict {
        band: Band::from_complexity(complexity),
        requested: "jev",
        decided_by: "jev",
        version: JEV_VERSION,
        status: VerdictStatus::Used,
        probabilities: None,
        cost_micros,
        cost_source: recorded.cost_source,
        input_tokens: usage.input_tokens.map_or(0, |t| t.0),
        output_tokens: usage.output_tokens.map_or(0, |t| t.0),
    }
}

struct ReasonPlan<'a> {
    verdict: &'a Verdict,
    how: How,
    chosen: &'a Candidate,
    budget: (u64, u64),
    swap: Option<(&'static str, String)>,
    floor: Option<Band>,
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
    let band = plan.verdict.band.as_str();
    let lead = match &plan.verdict.status {
        VerdictStatus::Used if plan.verdict.decided_by == "heuristic" => {
            format!("{band} task estimated from its text (heuristic classifier)")
        }
        VerdictStatus::Used => format!("{band} task"),
        VerdictStatus::Fallback(why) => {
            format!("{band} task estimated from its text (classifier not used: {why})")
        }
        VerdictStatus::Skipped => format!(
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
    let floor_note = match plan.floor {
        Some(floor) => format!(
            " Retry of a failed delegation: at least the {} band.",
            floor.as_str()
        ),
        None => String::new(),
    };
    format!("{lead}; {rest}.{swap_note}{floor_note}")
}

fn capitalize(text: &str) -> String {
    let mut chars = text.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    }
}
