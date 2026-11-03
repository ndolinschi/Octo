mod config;
mod providers;
mod proxy;
mod routes;
mod state;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    if let Err(err) = proxy::run().await {
        tracing::error!(%err, "proxy exited with error");
        std::process::exit(1);
    }
}
