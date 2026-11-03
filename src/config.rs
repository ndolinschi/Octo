use std::path::PathBuf;

use serde::Deserialize;

#[derive(Clone, Debug)]
pub struct Config {
    pub bind_addr: String,
    pub openai_chat_completions_url: String,
    pub anthropic_messages_url: String,
    pub anthropic_api_version: String,
    pub max_body_bytes: usize,
    pub openai_chat_completions_path: String,
    pub openai_http_referer: Option<String>,
    pub openai_openrouter_title: Option<String>,
    pub anthropic_messages_path: String,
}

#[derive(Clone, Debug, Deserialize)]
struct ConfigFile {
    server: ServerSection,
    limits: LimitsSection,
    openai: OpenAiSection,
    anthropic: AnthropicSection,
}

#[derive(Clone, Debug, Deserialize)]
struct ServerSection {
    bind_addr: String,
}

#[derive(Clone, Debug, Deserialize)]
struct LimitsSection {
    max_body_bytes: usize,
}

#[derive(Clone, Debug, Deserialize)]
struct OpenAiSection {
    chat_completions_url: String,
    chat_completions_path: String,
    #[serde(default)]
    http_referer: Option<String>,
    #[serde(default)]
    openrouter_title: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
struct AnthropicSection {
    messages_url: String,
    messages_path: String,
    api_version: String,
}

impl Config {
    pub fn load() -> Result<Self, ConfigError> {
        let path = config_path();
        let contents = std::fs::read_to_string(&path).map_err(|source| ConfigError::Read {
            path: path.clone(),
            source,
        })?;
        let file: ConfigFile =
            toml::from_str(&contents).map_err(|source| ConfigError::Parse { path, source })?;
        Ok(Self {
            bind_addr: file.server.bind_addr,
            openai_chat_completions_url: file.openai.chat_completions_url,
            anthropic_messages_url: file.anthropic.messages_url,
            anthropic_api_version: file.anthropic.api_version,
            max_body_bytes: file.limits.max_body_bytes,
            openai_chat_completions_path: file.openai.chat_completions_path,
            openai_http_referer: file.openai.http_referer,
            openai_openrouter_title: file.openai.openrouter_title,
            anthropic_messages_path: file.anthropic.messages_path,
        })
    }
}

fn config_path() -> PathBuf {
    std::env::var("OCTO_CONFIG")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("config.toml"))
}

#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("failed to read config at {path}")]
    Read {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("failed to parse config at {path}")]
    Parse {
        path: PathBuf,
        #[source]
        source: toml::de::Error,
    },
}
