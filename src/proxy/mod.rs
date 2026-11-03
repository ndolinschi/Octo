mod handler;
mod routes;
mod state;

use std::net::SocketAddr;

use tracing::info;

pub use state::AppState;

use routes::router;

const BIND_ADDR: &str = "127.0.0.1:8080";

pub async fn run() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let addr: SocketAddr = BIND_ADDR.parse()?;
    let state = AppState::new()?;
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
