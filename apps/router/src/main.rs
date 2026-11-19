#[tokio::main]
async fn main() {
    // `--version` and `--help` print and exit before anything reads the config or binds a port.
    if let Some(out) = octo::cli::action(std::env::args().skip(1)) {
        match out {
            Ok(text) => {
                print!("{text}");
                return;
            }
            Err(text) => {
                eprint!("{text}");
                std::process::exit(2);
            }
        }
    }
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    if let Err(err) = octo::proxy::run().await {
        tracing::error!(%err, "proxy exited with error");
        std::process::exit(1);
    }
}
