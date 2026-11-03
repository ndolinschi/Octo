use reqwest::Client;

use crate::config::Config;
use crate::providers::{Anthropic, OpenAi};

#[derive(Clone)]
pub struct AppState {
    pub client: Client,
    pub config: Config,
    pub openai: OpenAi,
    pub anthropic: Anthropic,
}

impl AppState {
    pub fn new(config: Config) -> Result<Self, reqwest::Error> {
        let max_body_bytes = config.max_body_bytes;
        Ok(Self {
            client: Client::builder().build()?,
            openai: OpenAi::new(config.openai_chat_completions_url.clone(), max_body_bytes),
            anthropic: Anthropic::new(
                config.anthropic_messages_url.clone(),
                config.anthropic_api_version.clone(),
                max_body_bytes,
            ),
            config,
        })
    }
}
