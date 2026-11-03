pub mod error;
pub mod handler;
pub mod routes;
pub mod select;

use tracing::{info, warn};

use crate::config::Config;
use crate::providers::llm::{ChatCompletions, Messages};
use crate::proxy::select::ChatCompatProvider;
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
    let (default_chat_provider, default_chat_url) = match state.default_chat_provider {
        ChatCompatProvider::OpenAi => ("openai", state.llm.openai.upstream_url()),
        ChatCompatProvider::OpenRouter => ("openrouter", state.llm.openrouter.upstream_url()),
    };
    info!(
        chat_backend = %config.llm_chat_backend,
        default_chat_provider,
        default_chat_url,
        openai_chat_url = state.llm.openai.upstream_url(),
        openrouter_chat_url = state.llm.openrouter.upstream_url(),
        messages_backend = %config.llm_messages_backend,
        messages_url = state.llm.claude.upstream_url(),
        decisions_backend = %config.decision_backend,
        decisions_url = state.decision.openrouter.upstream_url(),
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
    let ctrl_c = tokio::signal::ctrl_c();

    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        let mut terminate = signal(SignalKind::terminate()).expect("install SIGTERM handler");
        tokio::select! {
            _ = ctrl_c => {}
            _ = terminate.recv() => {}
        }
    }

    #[cfg(not(unix))]
    {
        let _ = ctrl_c.await;
    }

    info!("shutdown signal received");
}
