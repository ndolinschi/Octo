use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::json;

use crate::state::AppState;

pub async fn call(State(state): State<AppState>, Path(request_id): Path<String>) -> Response {
    if let Some(row) = state.auto.call(&request_id) {
        return Json(row).into_response();
    }
    match state.history.call_record(&request_id).await {
        Some(row) => Json(row).into_response(),
        None => (
            StatusCode::NOT_FOUND,
            Json(json!({"error": "unknown or unfinished request", "request_id": request_id})),
        )
            .into_response(),
    }
}
