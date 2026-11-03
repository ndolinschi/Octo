use std::time::Duration;

use reqwest::Client;

use crate::config::{Config, ConfigError};
use crate::providers::{decision, llm};

#[derive(Clone)]
pub struct AppState {
    pub client: Client,
    pub config: Config,
    pub llm: llm::Providers,
    pub decision: decision::Providers,
}

impl AppState {
    pub fn new(config: Config) -> Result<Self, AppStateError> {
        let connect_timeout = Duration::from_secs(config.upstream_connect_timeout_secs);
        let request_timeout = Duration::from_secs(config.upstream_request_timeout_secs);
        Ok(Self {
            client: Client::builder()
                .connect_timeout(connect_timeout)
                .timeout(request_timeout)
                .build()?,
            llm: llm::Providers::from_config(&config)?,
            decision: decision::Providers::from_config(&config)?,
            config,
        })
    }
}

#[derive(Debug, thiserror::Error)]
pub enum AppStateError {
    #[error(transparent)]
    Config(#[from] ConfigError),
    #[error(transparent)]
    Client(#[from] reqwest::Error),
}
