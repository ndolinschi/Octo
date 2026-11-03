use axum::{routing::post, Router};

use crate::config::Config;
use crate::proxy::handler;
use crate::state::AppState;

pub fn router(config: &Config) -> Router<AppState> {
    Router::new()
        .route(
            config.openai_chat_completions_path.as_str(),
            post(handler::chat_completions),
        )
        .route(
            config.anthropic_messages_path.as_str(),
            post(handler::messages),
        )
}
