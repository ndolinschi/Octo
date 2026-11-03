use reqwest::Client;

use crate::providers::OpenAi;

#[derive(Clone)]
pub struct AppState {
    pub client: Client,
    pub provider: OpenAi,
}

impl AppState {
    pub fn new() -> Result<Self, reqwest::Error> {
        Ok(Self {
            client: Client::builder().build()?,
            provider: OpenAi,
        })
    }
}
