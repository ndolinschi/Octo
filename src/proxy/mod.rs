pub mod error;
pub mod handler;
pub mod routes;

use tracing::{info, warn};

use crate::config::Config;
use crate::providers::decision::Decisions;
use crate::providers::llm::{ChatCompletions, Messages};
use crate::routes::router;
use crate::state::AppState;

pub async fn run() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let config = Config::load()?;
    let addr = config.ensure_bind_allowed()?;
    if config.allow_remote && !addr.ip().is_loopback() {
        warn!(
            %addr,
            "listening on non-loopback address; Octo has no client authentication"
        );
    }
    let state = AppState::new(config.clone()).map_err(|err| {
        tracing::error!(%err, "failed to build application state");
        err
    })?;
    info!(
        chat_backend = %config.llm_chat_backend,
        chat_url = state.llm.chat.upstream_url(),
        messages_backend = %config.llm_messages_backend,
        decisions_backend = %config.decision_backend,
        decisions_url = state.decision.decisions.upstream_url(),
        anthropic_url = state.llm.messages.upstream_url(),
        "upstream urls"
    );
    let app = router(state);
    info!(%addr, "listening");
    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    Ok(())
}

async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
    info!("shutdown signal received");
}
