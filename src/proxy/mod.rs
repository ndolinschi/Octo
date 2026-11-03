pub mod error;
pub mod handler;
pub mod routes;

use std::net::SocketAddr;

use tracing::info;

use crate::config::Config;
use crate::providers::decision::Decisions;
use crate::providers::llm::{ChatCompletions, Messages};
use crate::routes::router;
use crate::state::AppState;

pub async fn run() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let config = Config::load()?;
    let addr: SocketAddr = config.bind_addr.parse()?;
    let state = AppState::new(config.clone()).map_err(|err| {
        tracing::error!(%err, "failed to build application state");
        err
    })?;
    info!(
        chat_url = state.llm.chat.upstream_url(),
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
