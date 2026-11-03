use reqwest::Client;

use crate::config::Config;
use crate::providers::{decision, llm};

#[derive(Clone)]
pub struct AppState {
    pub client: Client,
    pub config: Config,
    pub llm: llm::Providers,
    pub decision: decision::Providers,
}

impl AppState {
    pub fn new(config: Config) -> Result<Self, reqwest::Error> {
        let max_body_bytes = config.max_body_bytes;
        let http_referer = config.openrouter_http_referer.clone();
        let openrouter_title = config.openrouter_title.clone();
        Ok(Self {
            client: Client::builder().build()?,
            llm: llm::Providers::new(
                config.openrouter_chat_completions_url.clone(),
                config.anthropic_messages_url.clone(),
                config.anthropic_api_version.clone(),
                http_referer.clone(),
                openrouter_title.clone(),
                max_body_bytes,
            ),
            decision: decision::Providers::new(
                config.openrouter_decisions_url.clone(),
                http_referer,
                openrouter_title,
                max_body_bytes,
            ),
            config,
        })
    }
}
