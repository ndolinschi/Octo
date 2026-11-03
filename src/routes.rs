use axum::{routing::post, Router};
use tower_http::trace::TraceLayer;

use crate::proxy::handler;
use crate::state::AppState;

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/v1/chat/completions", post(handler::chat_completions))
        .route("/v1/messages", post(handler::messages))
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}
