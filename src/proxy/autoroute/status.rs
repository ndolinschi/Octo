use axum::{
    extract::{Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::state::AppState;

#[derive(Debug, Deserialize)]
pub struct StatusQuery {
    session: Option<String>,
}

pub async fn status(
    State(state): State<AppState>,
    Query(query): Query<StatusQuery>,
) -> Response {
    let session_id = match query.session {
        Some(id) if !id.is_empty() => id,
        _ => match state.auto.latest_session_id() {
            Some(id) => id,
            None => {
                return (
                    StatusCode::NOT_FOUND,
                    Json(json!({"error":"no session"})),
                )
                    .into_response();
            }
        },
    };
    match build_status(&state, &session_id).await {
        Some(body) => Json(body).into_response(),
        None => (
            StatusCode::NOT_FOUND,
            Json(json!({"error":"unknown session","session_id": session_id})),
        )
            .into_response(),
    }
}

async fn build_status(state: &AppState, session_id: &str) -> Option<Value> {
    let memory = state.auto.session_snapshot(session_id);
    let stats = state.history.session_call_stats(session_id).await;
    if memory.is_none() && stats.as_ref().is_none_or(|s| s.calls == 0) {
        return None;
    }
    let tier = memory
        .as_ref()
        .map(|row| row.sticky_band.clone())
        .unwrap_or_else(|| "unset".to_string());
    let model = memory
        .as_ref()
        .map(|row| row.model.clone())
        .filter(|m| !m.is_empty())
        .or_else(|| stats.as_ref().and_then(|s| s.last_model.clone()))
        .unwrap_or_default();
    let mem_cost = memory.as_ref().map(|row| row.cost_micros).unwrap_or(0);
    let db_cost = stats.as_ref().map(|s| s.cost_micros).unwrap_or(0);
    let cost_micros = mem_cost.max(db_cost);
    let last_trigger = stats
        .as_ref()
        .and_then(|s| s.last_trigger.clone())
        .unwrap_or_else(|| "none".to_string());
    let calls = stats.as_ref().map(|s| s.calls).unwrap_or(0);
    let breakdown = stats
        .as_ref()
        .map(|s| s.cost_source_breakdown.clone())
        .unwrap_or_else(|| json!({}));
    let updated_at = stats.as_ref().map(|s| s.updated_at).unwrap_or(0);
    Some(json!({
        "session_id": session_id,
        "tier": tier,
        "model": model,
        "last_trigger": last_trigger,
        "calls": calls,
        "cost_usd": (cost_micros as f64) / 1_000_000.0,
        "cost_source_breakdown": breakdown,
        "budget_usd": state.config.autoroute_session_budget_usd,
        "updated_at": updated_at,
    }))
}
