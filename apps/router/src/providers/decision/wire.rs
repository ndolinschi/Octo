use crate::config::{Config, ConfigError};

use super::openrouter::OpenRouter;

#[derive(Clone)]
pub struct Providers {
    pub openrouter: OpenRouter,
}

impl Providers {
    pub fn from_config(config: &Config) -> Result<Self, ConfigError> {
        let openrouter = match config.decision_backend.as_str() {
            "openrouter" => OpenRouter::new(
                config.openrouter_decisions_url.clone(),
                config.openrouter_http_referer.clone(),
                config.openrouter_title.clone(),
                config.max_body_bytes,
            ),
            other => {
                return Err(ConfigError::UnknownBackend {
                    kind: "decision",
                    name: other.to_string(),
                });
            }
        };
        Ok(Self { openrouter })
    }
}
