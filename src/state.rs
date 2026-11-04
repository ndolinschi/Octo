use std::time::Duration;

use reqwest::Client;

use crate::config::{Config, ConfigError};
use crate::history::History;
use crate::providers::{decision, llm};
use crate::proxy::select::{self, ChatCompatProvider, MessagesProvider};

#[derive(Clone)]
pub struct AppState {
    pub client: Client,
    pub config: Config,
    pub default_chat_provider: ChatCompatProvider,
    pub default_messages_provider: MessagesProvider,
    pub llm: llm::Providers,
    pub decision: decision::Providers,
    pub history: History,
}

impl AppState {
    pub fn new(config: Config) -> Result<Self, AppStateError> {
        let default_chat_provider = select::chat_compat_from_llm_backend(&config.llm_chat_backend)
            .ok_or_else(|| ConfigError::UnknownBackend {
                kind: "llm.chat",
                name: config.llm_chat_backend.clone(),
            })?;
        let default_messages_provider = select::parse_messages_provider_token(
            &config.llm_messages_backend,
        )
        .ok_or_else(|| ConfigError::UnknownBackend {
            kind: "llm.messages",
            name: config.llm_messages_backend.clone(),
        })?;
        let connect_timeout = Duration::from_secs(config.upstream_connect_timeout_secs);
        let request_timeout = Duration::from_secs(config.upstream_request_timeout_secs);
        Ok(Self {
            client: Client::builder()
                .connect_timeout(connect_timeout)
                .timeout(request_timeout)
                .build()?,
            default_chat_provider,
            default_messages_provider,
            llm: llm::Providers::from_config(&config),
            decision: decision::Providers::from_config(&config)?,
            history: History::disabled(),
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
