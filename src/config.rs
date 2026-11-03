const DEFAULT_BIND_ADDR: &str = "127.0.0.1:8080";
const DEFAULT_OPENAI_CHAT_COMPLETIONS_URL: &str = "https://api.openai.com/v1/chat/completions";
const DEFAULT_ANTHROPIC_MESSAGES_URL: &str = "https://api.anthropic.com/v1/messages";
const DEFAULT_ANTHROPIC_API_VERSION: &str = "2023-06-01";
const DEFAULT_MAX_BODY_BYTES: usize = 10 * 1024 * 1024;
const DEFAULT_OPENAI_CHAT_COMPLETIONS_PATH: &str = "/v1/chat/completions";
const DEFAULT_ANTHROPIC_MESSAGES_PATH: &str = "/v1/messages";

const ENV_BIND_ADDR: &str = "OCTO_BIND_ADDR";
const ENV_OPENAI_CHAT_COMPLETIONS_URL: &str = "OCTO_OPENAI_CHAT_COMPLETIONS_URL";
const ENV_ANTHROPIC_MESSAGES_URL: &str = "OCTO_ANTHROPIC_MESSAGES_URL";
const ENV_ANTHROPIC_API_VERSION: &str = "OCTO_ANTHROPIC_API_VERSION";
const ENV_MAX_BODY_BYTES: &str = "OCTO_MAX_BODY_BYTES";
const ENV_OPENAI_CHAT_COMPLETIONS_PATH: &str = "OCTO_OPENAI_CHAT_COMPLETIONS_PATH";
const ENV_ANTHROPIC_MESSAGES_PATH: &str = "OCTO_ANTHROPIC_MESSAGES_PATH";

#[derive(Clone, Debug)]
pub struct Config {
    pub bind_addr: String,
    pub openai_chat_completions_url: String,
    pub anthropic_messages_url: String,
    pub anthropic_api_version: String,
    pub max_body_bytes: usize,
    pub openai_chat_completions_path: String,
    pub anthropic_messages_path: String,
}

impl Config {
    pub fn from_env() -> Result<Self, ConfigError> {
        let max_body_bytes = match std::env::var(ENV_MAX_BODY_BYTES) {
            Ok(value) => value
                .parse()
                .map_err(|_| ConfigError::InvalidMaxBodyBytes)?,
            Err(_) => DEFAULT_MAX_BODY_BYTES,
        };
        Ok(Self {
            bind_addr: env_or(ENV_BIND_ADDR, DEFAULT_BIND_ADDR),
            openai_chat_completions_url: env_or(
                ENV_OPENAI_CHAT_COMPLETIONS_URL,
                DEFAULT_OPENAI_CHAT_COMPLETIONS_URL,
            ),
            anthropic_messages_url: env_or(
                ENV_ANTHROPIC_MESSAGES_URL,
                DEFAULT_ANTHROPIC_MESSAGES_URL,
            ),
            anthropic_api_version: env_or(ENV_ANTHROPIC_API_VERSION, DEFAULT_ANTHROPIC_API_VERSION),
            max_body_bytes,
            openai_chat_completions_path: env_or(
                ENV_OPENAI_CHAT_COMPLETIONS_PATH,
                DEFAULT_OPENAI_CHAT_COMPLETIONS_PATH,
            ),
            anthropic_messages_path: env_or(
                ENV_ANTHROPIC_MESSAGES_PATH,
                DEFAULT_ANTHROPIC_MESSAGES_PATH,
            ),
        })
    }
}

fn env_or(key: &str, default: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| default.to_string())
}

#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("invalid OCTO_MAX_BODY_BYTES value")]
    InvalidMaxBodyBytes,
}
