use axum::Router;
use tower_http::trace::TraceLayer;

use crate::proxy;
use crate::state::AppState;

pub fn router(state: AppState) -> Router {
    proxy::routes::router(&state.config)
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}
