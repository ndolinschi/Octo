use crate::config::Config;

use super::claude::Claude;
use super::openai::OpenAI;
use super::openrouter::OpenRouter;

#[derive(Clone)]
pub struct Wired {
    pub openai: OpenAI,
    pub openrouter: OpenRouter,
    pub claude: Claude,
}

impl Wired {
    pub fn from_config(config: &Config) -> Self {
        Self {
            openai: OpenAI::new(
                config.openai_chat_completions_url.clone(),
                config.max_body_bytes,
            ),
            openrouter: OpenRouter::new(
                config.openrouter_chat_completions_url.clone(),
                config.openrouter_http_referer.clone(),
                config.openrouter_title.clone(),
                config.max_body_bytes,
            ),
            claude: Claude::new(
                config.anthropic_messages_url.clone(),
                config.anthropic_api_version.clone(),
                config.max_body_bytes,
            ),
        }
    }
}
