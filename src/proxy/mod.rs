pub mod error;
pub mod handler;

use std::net::SocketAddr;

use tracing::info;

use crate::providers::{Anthropic, OpenAi};
use crate::routes::router;
use crate::state::AppState;

const BIND_ADDR: &str = "127.0.0.1:8080";
const OPENAI_CHAT_COMPLETIONS_URL_ENV: &str = "OCTO_OPENAI_CHAT_COMPLETIONS_URL";
const ANTHROPIC_MESSAGES_URL_ENV: &str = "OCTO_ANTHROPIC_MESSAGES_URL";

fn openai_provider() -> OpenAi {
    match std::env::var(OPENAI_CHAT_COMPLETIONS_URL_ENV) {
        Ok(url) => OpenAi::with_chat_completions_url(url),
        Err(_) => OpenAi::default(),
    }
}

fn anthropic_provider() -> Anthropic {
    match std::env::var(ANTHROPIC_MESSAGES_URL_ENV) {
        Ok(url) => Anthropic::with_messages_url(url),
        Err(_) => Anthropic::default(),
    }
}

pub async fn run() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let addr: SocketAddr = BIND_ADDR.parse()?;
    let openai = openai_provider();
    let anthropic = anthropic_provider();
    info!(
        openai_url = openai.chat_completions_url(),
        anthropic_url = anthropic.messages_url(),
        "upstream urls"
    );
    let state = AppState::with_providers(openai, anthropic)?;
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
