use reqwest::Client;

use crate::providers::{Anthropic, OpenAi};

#[derive(Clone)]
pub struct AppState {
    pub client: Client,
    pub openai: OpenAi,
    pub anthropic: Anthropic,
}

impl AppState {
    pub fn with_providers(openai: OpenAi, anthropic: Anthropic) -> Result<Self, reqwest::Error> {
        Ok(Self {
            client: Client::builder().build()?,
            openai,
            anthropic,
        })
    }
}
