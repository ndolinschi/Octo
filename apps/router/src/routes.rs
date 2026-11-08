use axum::{middleware, Router};
use tower_http::trace::TraceLayer;

use crate::proxy;
use crate::state::AppState;

pub fn router(state: AppState) -> Router {
    proxy::routes::router(&state.config)
        .layer(middleware::from_fn_with_state(
            state.clone(),
            proxy::auth::require_client_auth,
        ))
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}
