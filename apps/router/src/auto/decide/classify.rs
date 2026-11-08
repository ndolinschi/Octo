use reqwest::Client;
use serde_json::Value;

use crate::history::{DecisionRow, History};

use super::super::body;
use super::super::catalog::Tiers;
use super::super::jev;
use super::super::Auto;

pub(super) struct ClassifyCtx<'a> {
    pub auto: &'a Auto,
    pub history: &'a History,
    pub session_id: Option<String>,
    pub client: &'a Client,
    pub decisions_url: &'a str,
    pub api_key: &'a str,
    pub body: &'a Value,
    pub all_tools: &'a [String],
    pub tiers: &'a Tiers,
    pub current_tier: &'a str,
}

pub(super) struct ClassifyTurn<'a> {
    pub ctx: &'a ClassifyCtx<'a>,
    pub preferred: Option<&'a str>,
    pub current: &'a [String],
    pub purpose: &'a str,
}

pub(super) struct ClassifiedPick {
    pub complexity: jev::Complexity,
    pub model: String,
    pub tools: Vec<String>,
}

pub(super) async fn fresh(
    ctx: &ClassifyCtx<'_>,
    preferred: Option<&str>,
) -> Option<ClassifiedPick> {
    turn(ClassifyTurn {
        ctx,
        preferred,
        current: &[],
        purpose: "classify",
    })
    .await
}

pub(super) async fn turn(plan: ClassifyTurn<'_>) -> Option<ClassifiedPick> {
    if plan.ctx.api_key.is_empty() {
        return None;
    }
    let user_text = body::question_text(plan.ctx.body);
    let facts = jev::inspect(plan.ctx.body, &user_text);
    let asked = jev::classify(jev::ClassifyRequest {
        client: plan.ctx.client,
        decisions_url: plan.ctx.decisions_url,
        api_key: plan.ctx.api_key,
        user_text: &user_text,
        tool_names: plan.ctx.all_tools,
        current_tools: plan.current,
        facts: &facts,
        current_tier: plan.ctx.current_tier,
        thresholds: jev::Thresholds {
            hard: plan.ctx.tiers.hard_threshold,
            easy: plan.ctx.tiers.easy_threshold,
        },
    })
    .await;
    record(RecordPlan {
        auto: plan.ctx.auto,
        history: plan.ctx.history,
        session_id: plan.ctx.session_id.clone(),
        purpose: plan.purpose,
        asked: &asked,
    });
    let classified = asked.parsed?;
    let complexity =
        bump_tool_inspection_off_easy(classified.complexity, plan.ctx.all_tools, &user_text);
    let model = plan.ctx.tiers.pick(complexity, plan.preferred);
    let tools = jev::needed_tools(jev::ToolNeed {
        all: plan.ctx.all_tools,
        current: plan.current,
        enough: classified.tools_enough,
        missing: &classified.missing_tools,
    });
    Some(ClassifiedPick {
        complexity,
        model,
        tools,
    })
}

fn bump_tool_inspection_off_easy(
    complexity: jev::Complexity,
    tools: &[String],
    user_text: &str,
) -> jev::Complexity {
    if !matches!(complexity, jev::Complexity::Low) || tools.is_empty() {
        return complexity;
    }
    if jev::asks_file_or_repo_inspection(user_text) {
        jev::Complexity::Mid
    } else {
        complexity
    }
}

struct RecordPlan<'a> {
    auto: &'a Auto,
    history: &'a History,
    session_id: Option<String>,
    purpose: &'a str,
    asked: &'a jev::Asked,
}

fn record(plan: RecordPlan<'_>) {
    let parsed = plan.asked.parsed.as_ref();
    let usage = crate::history::usage_from_output(&plan.asked.response_body);
    let resolved =
        crate::history::resolve_cost(&usage, Some("typesafe/jev-1.13"), plan.history.prices());
    let cost = resolved.cost.or(plan.asked.cost);
    if let (Some(session_id), Some(cost)) = (&plan.session_id, cost) {
        plan.auto.add_session_cost(session_id, cost.0);
    }
    plan.history.record_decision(DecisionRow {
        session_id: plan.session_id,
        purpose: plan.purpose.to_string(),
        model: "typesafe/jev-1.13".to_string(),
        status: plan.asked.status,
        latency_ms: plan.asked.latency_ms,
        user_text: body::cap_decision_text(&user_text_from_request(&plan.asked.request_body)),
        is_hard: parsed.and_then(|row| row.is_hard),
        is_easy: parsed.and_then(|row| row.is_easy),
        is_hard_score: parsed.and_then(|row| row.is_hard_score),
        is_easy_score: parsed.and_then(|row| row.is_easy_score),
        tools_enough: parsed.and_then(|row| row.tools_enough_raw.clone()),
        complexity: parsed.map(|row| match row.complexity {
            jev::Complexity::Low => "low",
            jev::Complexity::Mid => "mid",
            jev::Complexity::High => "high",
        }),
        choice_rule: plan.asked.choice_rule.to_string(),
        missing_tools: parsed.map(|row| row.missing_tools.join(",")),
        request_payload: plan.asked.request_body.clone(),
        response_payload: plan.asked.response_body.clone(),
        cost,
        or_cost: resolved.or_cost,
        upstream_cost: resolved.upstream_cost,
        estimated_cost: resolved.estimated_cost,
        cost_source: resolved.source.as_str().to_string(),
    });
}

fn user_text_from_request(body: &str) -> String {
    serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|value| {
            value
                .get("state")
                .and_then(|state| state.get("user_text"))
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .unwrap_or_default()
}
