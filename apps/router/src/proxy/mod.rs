pub mod auth;
pub mod autoroute;
pub mod error;
pub mod handler;
pub mod routes;
pub mod select;

use tracing::info;

use crate::config::Config;
use crate::history::History;
use crate::proxy::select::{ChatCompatProvider, MessagesProvider};
use crate::routes::router;
use crate::state::AppState;

pub async fn run() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let config = Config::load()?;
    let addr = config.ensure_bind_allowed()?;
    if config.allow_remote && !addr.ip().is_loopback() {
        info!(
            %addr,
            "listening on non-loopback address; requests require x-octo-key"
        );
    }
    let mut state = AppState::new(config.clone()).map_err(|err| {
        tracing::error!(%err, "failed to build application state");
        err
    })?;
    for warning in crate::auto::ladder_warnings(state.auto.tiers()) {
        tracing::warn!("{warning}");
    }
    match History::connect(
        &config.history_database_path,
        &config.history_token_key,
        config.max_body_bytes,
    )
    .await
    {
        Ok(history) => {
            state.history = history
                .with_prices(config.prices.clone())
                .with_store_payloads(config.history_store_payloads);
            info!(
                database = %config.history_database_path,
                "history database ready"
            );
        }
        Err(err) => {
            tracing::error!(%err, "history disabled; proxy will keep serving");
        }
    }
    let (default_chat_provider, default_chat_url) = match state.default_chat_provider {
        ChatCompatProvider::OpenAi => ("openai", state.llm.openai.chat_completions_url()),
        ChatCompatProvider::OpenRouter => {
            ("openrouter", state.llm.openrouter.chat_completions_url())
        }
    };
    let (default_messages_provider, default_messages_url) = match state.default_messages_provider {
        MessagesProvider::Claude => ("claude", state.llm.claude.messages_url()),
        MessagesProvider::OpenRouter => ("openrouter", state.llm.openrouter.messages_url()),
    };
    info!(
        chat_backend = %config.llm_chat_backend,
        default_chat_provider,
        default_chat_url,
        openai_chat_url = state.llm.openai.chat_completions_url(),
        openrouter_chat_url = state.llm.openrouter.chat_completions_url(),
        messages_backend = %config.llm_messages_backend,
        default_messages_provider,
        default_messages_url,
        claude_messages_url = state.llm.claude.messages_url(),
        openrouter_messages_url = state.llm.openrouter.messages_url(),
        decisions_backend = %config.decision_backend,
        decisions_url = state.decision.openrouter.upstream_url(),
        "upstream urls"
    );
    let history = state.history.clone();
    let app = router(state);
    info!(%addr, "listening");
    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    history.drain().await;
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
