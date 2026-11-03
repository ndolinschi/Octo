mod handler;

use std::net::SocketAddr;

use axum::{routing::post, Router};
use reqwest::Client;
use tower_http::trace::TraceLayer;
use tracing::info;

const BIND_ADDR: &str = "127.0.0.1:8080";

#[derive(Clone)]
pub struct AppState {
    pub client: Client,
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/v1/chat/completions", post(handler::chat_completions))
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}

pub async fn run() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let addr: SocketAddr = BIND_ADDR.parse()?;
    let state = AppState {
        client: Client::builder().build()?,
    };

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
