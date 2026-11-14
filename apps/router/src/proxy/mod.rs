pub mod auth;
pub mod autoroute;
pub mod error;
pub mod handler;
pub mod routes;
pub mod select;
pub mod stdin_watch;

use std::time::Duration;

use tracing::info;

use crate::config::Config;
use crate::history::{History, Retention};
use crate::proxy::select::{ChatCompatProvider, MessagesProvider};
use crate::routes::router;
use crate::state::AppState;

fn retention_from(config: &Config) -> Retention {
    let days = |n: u64| (n > 0).then(|| Duration::from_secs(n.saturating_mul(86_400)));
    Retention {
        calls_max_age: days(config.history_calls_max_age_days),
        calls_max_rows: (config.history_calls_max_rows > 0)
            .then_some(config.history_calls_max_rows),
        spend_max_age: days(config.history_budget_spend_max_age_days),
    }
}

pub async fn run() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let (config, embedded) = Config::load_with_report()?;
    if !embedded.is_empty() {
        info!(
            files = %embedded.join(", "),
            "config files missing from the config directory; using the defaults embedded in the binary"
        );
    }
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
    let price_refresh = crate::prices::start(&config, &state.prices, state.auto.tiers());
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
                .with_prices(state.prices.live())
                .with_store_payloads(config.history_store_payloads)
                .with_retention(retention_from(&config));
            state
                .history
                .spawn_pruner(Duration::from_secs(config.history_prune_interval_secs));
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
    if let Some(task) = price_refresh {
        task.abort();
    }
    history.drain().await;
    Ok(())
}

async fn shutdown_signal() {
    let ctrl_c = tokio::signal::ctrl_c();
    let stdin_closed = stdin_watch::stdin_closed();

    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        let mut terminate = signal(SignalKind::terminate()).expect("install SIGTERM handler");
        tokio::select! {
            _ = ctrl_c => {}
            _ = terminate.recv() => {}
            _ = stdin_closed => info!("stdin closed ({})", stdin_watch::EXIT_ON_STDIN_CLOSE_ENV),
        }
    }

    #[cfg(not(unix))]
    {
        tokio::select! {
            _ = ctrl_c => {}
            _ = stdin_closed => info!("stdin closed ({})", stdin_watch::EXIT_ON_STDIN_CLOSE_ENV),
        }
    }

    info!("shutdown signal received");
}
