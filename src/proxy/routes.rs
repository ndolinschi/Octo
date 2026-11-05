use axum::{
    routing::{get, post},
    Router,
};

use crate::config::Config;
use crate::proxy::{autoroute, handler};
use crate::state::AppState;

pub fn router(config: &Config) -> Router<AppState> {
    Router::new()
        .route("/health", get(handler::health))
        .route(
            config.openrouter_chat_completions_path.as_str(),
            post(handler::chat_completions),
        )
        .route(
            "/openai/completions",
            post(handler::chat_completions_openai),
        )
        .route(
            "/openai/v1/chat/completions",
            post(handler::chat_completions_openai),
        )
        .route(
            "/openrouter/completions",
            post(handler::chat_completions_openrouter),
        )
        .route(
            "/openrouter/v1/chat/completions",
            post(handler::chat_completions_openrouter),
        )
        .route(
            config.openrouter_decisions_path.as_str(),
            post(handler::decisions),
        )
        .route("/openrouter/decisions", post(handler::decisions))
        .route("/openrouter/v1/decisions", post(handler::decisions))
        .route(
            config.anthropic_messages_path.as_str(),
            post(handler::messages),
        )
        .route("/claude/messages", post(handler::messages_claude))
        .route("/claude/v1/messages", post(handler::messages_claude))
        .route("/anthropic/messages", post(handler::messages_claude))
        .route("/anthropic/v1/messages", post(handler::messages_claude))
        .route("/openrouter/messages", post(handler::messages_openrouter))
        .route(
            "/openrouter/v1/messages",
            post(handler::messages_openrouter),
        )
        .route("/autoroute/v1/messages", post(autoroute::messages))
        .route("/autoroute/v1/chat/completions", post(autoroute::chat))
}
