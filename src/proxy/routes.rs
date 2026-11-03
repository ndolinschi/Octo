use axum::{routing::post, Router};
use tower_http::trace::TraceLayer;

use super::{handler, AppState};

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/v1/chat/completions", post(handler::chat_completions))
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}
