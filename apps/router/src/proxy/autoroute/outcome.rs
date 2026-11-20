use axum::{
    body::to_bytes,
    extract::{Path, Request, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::{json, Value};

use crate::auto::{derive_label, finished_session, parse_reports, Label, OutcomeReport};
use crate::history::{History, HistoryError, LabelColumns};
use crate::proxy::error::ProxyError;
use crate::state::AppState;

fn not_stored(status: StatusCode, message: &str, request_id: &str) -> Response {
    (
        status,
        Json(json!({"error": message, "request_id": request_id})),
    )
        .into_response()
}

fn failed(err: HistoryError, request_id: &str) -> Response {
    tracing::warn!(%err, request_id, "delegation outcome storage failed");
    not_stored(
        StatusCode::SERVICE_UNAVAILABLE,
        "history storage failed",
        request_id,
    )
}

/// Recomputes and stores the label of a delegation from every report it has.
async fn relabel(history: &History, request_id: &str) -> Result<(Label, usize), HistoryError> {
    let bodies: Vec<Value> = history
        .outcomes(request_id)
        .await?
        .into_iter()
        .map(|outcome| outcome.body)
        .collect();
    let reports = parse_reports(&bodies);
    let session = match finished_session(&reports) {
        Some(id) => history.session_outcome(id).await,
        None => None,
    };
    let label = derive_label(&reports, session.as_ref());
    history
        .set_delegation_label(
            request_id,
            &LabelColumns {
                solved: label.solved.as_str(),
                rule: label.rule,
                confidence: label.confidence,
            },
        )
        .await?;
    Ok((label, reports.len()))
}

pub async fn report_outcome(
    State(state): State<AppState>,
    Path(request_id): Path<String>,
    request: Request,
) -> Result<Response, ProxyError> {
    let bytes = to_bytes(request.into_body(), state.config.max_body_bytes)
        .await
        .map_err(|err| ProxyError::from_read_body(err).as_anthropic_messages())?;
    let report: OutcomeReport = serde_json::from_slice(&bytes).map_err(|err| {
        ProxyError::anthropic(
            StatusCode::BAD_REQUEST,
            "invalid_request_error",
            format!("invalid outcome report: {err}"),
        )
    })?;
    report.validate().map_err(|message| {
        ProxyError::anthropic(
            StatusCode::UNPROCESSABLE_ENTITY,
            "invalid_request_error",
            message,
        )
    })?;
    let history = &state.history;
    if !history.enabled() {
        return Ok(not_stored(
            StatusCode::SERVICE_UNAVAILABLE,
            "history disabled: outcomes are not stored",
            &request_id,
        ));
    }
    match history.delegation(&request_id).await {
        Ok(Some(_)) => {}
        Ok(None) => {
            return Ok(not_stored(
                StatusCode::NOT_FOUND,
                "unknown delegation",
                &request_id,
            ))
        }
        Err(err) => return Ok(failed(err, &request_id)),
    }
    let body = serde_json::to_value(&report).unwrap_or(Value::Null);
    let stored = match history
        .insert_outcome(&request_id, &report.report_id, report.event.as_str(), &body)
        .await
    {
        Ok(stored) => stored,
        Err(err) => return Ok(failed(err, &request_id)),
    };
    let (label, reports) = match relabel(history, &request_id).await {
        Ok(found) => found,
        Err(err) => return Ok(failed(err, &request_id)),
    };
    Ok(Json(json!({
        "request_id": request_id,
        "stored": stored,
        "duplicate": !stored,
        "reports": reports,
        "solved": label.solved,
        "rule": label.rule,
        "confidence": label.confidence,
        "note": label.note,
    }))
    .into_response())
}

pub async fn read_outcome(
    State(state): State<AppState>,
    Path(request_id): Path<String>,
) -> Response {
    let history = &state.history;
    let delegation = match history.delegation(&request_id).await {
        Ok(Some(found)) => found,
        Ok(None) => return not_stored(StatusCode::NOT_FOUND, "unknown delegation", &request_id),
        Err(err) => return failed(err, &request_id),
    };
    let outcomes = match history.outcomes(&request_id).await {
        Ok(found) => found,
        Err(err) => return failed(err, &request_id),
    };
    let bodies: Vec<Value> = outcomes.iter().map(|o| o.body.clone()).collect();
    let reports = parse_reports(&bodies);
    let session = match finished_session(&reports) {
        Some(id) => history.session_outcome(id).await,
        None => None,
    };
    let label = derive_label(&reports, session.as_ref());
    Json(json!({
        "request_id": request_id,
        "attempt": delegation.attempt,
        "escalated_from": delegation.escalated_from,
        "choice": delegation.choice,
        "band": delegation.band,
        "classifier": delegation.classifier,
        "solved": label.solved,
        "rule": label.rule,
        "confidence": label.confidence,
        "note": label.note,
        "reports": outcomes.iter().map(|o| json!({"event": o.event, "received_at": o.received_at, "body": o.body})).collect::<Vec<_>>(),
    }))
    .into_response()
}
