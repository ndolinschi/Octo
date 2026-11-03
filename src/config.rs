use std::net::SocketAddr;
use std::path::PathBuf;

use serde::Deserialize;

#[derive(Clone, Debug)]
pub struct Config {
    pub bind_addr: String,
    pub allow_remote: bool,
    pub upstream_connect_timeout_secs: u64,
    pub upstream_request_timeout_secs: u64,
    pub openai_chat_completions_url: String,
    pub openrouter_chat_completions_url: String,
    pub openrouter_chat_completions_path: String,
    pub openrouter_decisions_url: String,
    pub openrouter_decisions_path: String,
    pub openrouter_http_referer: Option<String>,
    pub openrouter_title: Option<String>,
    pub anthropic_messages_url: String,
    pub anthropic_api_version: String,
    pub anthropic_messages_path: String,
    pub max_body_bytes: usize,
    pub llm_chat_backend: String,
    pub llm_messages_backend: String,
    pub decision_backend: String,
}

#[derive(Clone, Debug, Deserialize)]
struct ConfigFile {
    server: ServerSection,
    #[serde(default)]
    upstream: UpstreamSection,
    limits: LimitsSection,
    #[serde(default)]
    openai: OpenAiSection,
    openrouter: OpenRouterSection,
    #[serde(default)]
    llm: LlmSection,
    #[serde(default)]
    decision: DecisionSection,
    anthropic: AnthropicSection,
}

#[derive(Clone, Debug, Deserialize)]
struct ServerSection {
    bind_addr: String,
    #[serde(default)]
    allow_remote: bool,
}

#[derive(Clone, Debug, Deserialize)]
struct UpstreamSection {
    #[serde(default = "default_upstream_connect_timeout_secs")]
    connect_timeout_secs: u64,
    #[serde(default = "default_upstream_request_timeout_secs")]
    request_timeout_secs: u64,
}

impl Default for UpstreamSection {
    fn default() -> Self {
        Self {
            connect_timeout_secs: default_upstream_connect_timeout_secs(),
            request_timeout_secs: default_upstream_request_timeout_secs(),
        }
    }
}

fn default_upstream_connect_timeout_secs() -> u64 {
    30
}

fn default_upstream_request_timeout_secs() -> u64 {
    600
}

#[derive(Clone, Debug, Deserialize)]
struct LimitsSection {
    max_body_bytes: usize,
}

#[derive(Clone, Debug, Deserialize)]
struct OpenAiSection {
    #[serde(default = "default_openai_chat_completions_url")]
    chat_completions_url: String,
}

fn default_openai_chat_completions_url() -> String {
    "https://api.openai.com/v1/chat/completions".to_string()
}

impl Default for OpenAiSection {
    fn default() -> Self {
        Self {
            chat_completions_url: default_openai_chat_completions_url(),
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
struct OpenRouterSection {
    chat_completions_url: String,
    chat_completions_path: String,
    #[serde(default = "default_decisions_url")]
    decisions_url: String,
    #[serde(default = "default_decisions_path")]
    decisions_path: String,
    #[serde(default)]
    http_referer: Option<String>,
    #[serde(default)]
    openrouter_title: Option<String>,
}

fn default_decisions_url() -> String {
    "https://openrouter.ai/api/alpha/decisions".to_string()
}

fn default_decisions_path() -> String {
    "/v1/decisions".to_string()
}

#[derive(Clone, Debug, Deserialize)]
struct AnthropicSection {
    messages_url: String,
    messages_path: String,
    api_version: String,
}

#[derive(Clone, Debug, Deserialize)]
struct LlmSection {
    #[serde(default)]
    chat: ChatBackendSection,
    #[serde(default)]
    messages: MessagesBackendSection,
}

#[derive(Clone, Debug, Deserialize)]
struct DecisionSection {
    #[serde(default = "default_decision_backend")]
    backend: String,
}

#[derive(Clone, Debug, Deserialize)]
struct ChatBackendSection {
    #[serde(default = "default_llm_chat_backend")]
    backend: String,
}

#[derive(Clone, Debug, Deserialize)]
struct MessagesBackendSection {
    #[serde(default = "default_llm_messages_backend")]
    backend: String,
}

impl Default for ChatBackendSection {
    fn default() -> Self {
        Self {
            backend: default_llm_chat_backend(),
        }
    }
}

impl Default for MessagesBackendSection {
    fn default() -> Self {
        Self {
            backend: default_llm_messages_backend(),
        }
    }
}

impl Default for LlmSection {
    fn default() -> Self {
        Self {
            chat: ChatBackendSection {
                backend: default_llm_chat_backend(),
            },
            messages: MessagesBackendSection {
                backend: default_llm_messages_backend(),
            },
        }
    }
}

impl Default for DecisionSection {
    fn default() -> Self {
        Self {
            backend: default_decision_backend(),
        }
    }
}

fn default_llm_chat_backend() -> String {
    "openai".to_string()
}

fn default_llm_messages_backend() -> String {
    "claude".to_string()
}

fn default_decision_backend() -> String {
    "openrouter".to_string()
}

impl Config {
    pub fn load() -> Result<Self, ConfigError> {
        Self::load_from_path(&config_path())
    }

    pub fn load_from_path(path: &std::path::Path) -> Result<Self, ConfigError> {
        let contents = std::fs::read_to_string(path).map_err(|source| ConfigError::Read {
            path: path.to_path_buf(),
            source,
        })?;
        let file: ConfigFile = toml::from_str(&contents).map_err(|source| ConfigError::Parse {
            path: path.to_path_buf(),
            source,
        })?;
        Ok(Self {
            bind_addr: file.server.bind_addr,
            allow_remote: file.server.allow_remote,
            upstream_connect_timeout_secs: file.upstream.connect_timeout_secs,
            upstream_request_timeout_secs: file.upstream.request_timeout_secs,
            openai_chat_completions_url: file.openai.chat_completions_url,
            openrouter_chat_completions_url: file.openrouter.chat_completions_url,
            openrouter_chat_completions_path: file.openrouter.chat_completions_path,
            openrouter_decisions_url: file.openrouter.decisions_url,
            openrouter_decisions_path: file.openrouter.decisions_path,
            openrouter_http_referer: file.openrouter.http_referer,
            openrouter_title: file.openrouter.openrouter_title,
            anthropic_messages_url: file.anthropic.messages_url,
            anthropic_api_version: file.anthropic.api_version,
            anthropic_messages_path: file.anthropic.messages_path,
            max_body_bytes: file.limits.max_body_bytes,
            llm_chat_backend: file.llm.chat.backend,
            llm_messages_backend: file.llm.messages.backend,
            decision_backend: file.decision.backend,
        })
    }

    pub fn parse_bind_addr(&self) -> Result<SocketAddr, ConfigError> {
        self.bind_addr
            .parse()
            .map_err(|source| ConfigError::InvalidBindAddr {
                addr: self.bind_addr.clone(),
                source,
            })
    }

    pub fn ensure_bind_allowed(&self) -> Result<SocketAddr, ConfigError> {
        let addr = self.parse_bind_addr()?;
        if !addr.ip().is_loopback() && !self.allow_remote {
            return Err(ConfigError::RemoteBindNotAllowed {
                addr: self.bind_addr.clone(),
            });
        }
        Ok(addr)
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
    #[error("unknown {kind} backend {name}")]
    UnknownBackend { kind: &'static str, name: String },
    #[error("invalid bind_addr {addr}")]
    InvalidBindAddr {
        addr: String,
        #[source]
        source: std::net::AddrParseError,
    },
    #[error(
        "bind_addr {addr} is not loopback; set server.allow_remote = true to listen on non-loopback addresses"
    )]
    RemoteBindNotAllowed { addr: String },
}
