use crate::config::{Config, ConfigError};

use super::anthropic::Anthropic;
use super::openai::OpenAi;

#[derive(Clone)]
pub struct Providers<C, M> {
    pub chat: C,
    pub messages: M,
}

pub type Wired = Providers<OpenAi, Anthropic>;

impl Wired {
    pub fn from_config(config: &Config) -> Result<Self, ConfigError> {
        let chat = match config.llm_chat_backend.as_str() {
            "openrouter" => OpenAi::new(
                config.openrouter_chat_completions_url.clone(),
                config.openrouter_http_referer.clone(),
                config.openrouter_title.clone(),
                config.max_body_bytes,
            ),
            other => {
                return Err(ConfigError::UnknownBackend {
                    kind: "llm.chat",
                    name: other.to_string(),
                });
            }
        };
        let messages = match config.llm_messages_backend.as_str() {
            "anthropic" => Anthropic::new(
                config.anthropic_messages_url.clone(),
                config.anthropic_api_version.clone(),
                config.max_body_bytes,
            ),
            other => {
                return Err(ConfigError::UnknownBackend {
                    kind: "llm.messages",
                    name: other.to_string(),
                });
            }
        };
        Ok(Self { chat, messages })
    }
}
