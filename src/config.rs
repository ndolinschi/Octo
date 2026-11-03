use std::net::SocketAddr;
use std::path::{Path, PathBuf};

use serde::Deserialize;
use toml::map::Map;
use toml::Value;

const CONFIG_DIR_FILES: &[&str] = &[
    "server.toml",
    "upstream.toml",
    "limits.toml",
    "openai.toml",
    "openrouter.toml",
    "anthropic.toml",
    "llm.toml",
    "decision.toml",
];

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
        match config_location()? {
            ConfigLocation::Directory(dir) => Self::load_from_directory(&dir),
            ConfigLocation::File(path) => Self::load_from_path(&path),
        }
    }

    pub fn load_from_directory(dir: &Path) -> Result<Self, ConfigError> {
        let mut merged = Map::new();
        for name in CONFIG_DIR_FILES {
            let path = dir.join(name);
            let contents = std::fs::read_to_string(&path).map_err(|source| ConfigError::Read {
                path: path.clone(),
                source,
            })?;
            let table: Value = toml::from_str(&contents).map_err(|source| ConfigError::Parse {
                path: path.clone(),
                source,
            })?;
            let Value::Table(table) = table else {
                return Err(ConfigError::InvalidFragment { path });
            };
            merge_tables(&mut merged, table);
        }
        let serialized = toml::to_string(&Value::Table(merged)).map_err(|source| {
            ConfigError::Serialize {
                path: dir.to_path_buf(),
                source,
            }
        })?;
        let file: ConfigFile = toml::from_str(&serialized).map_err(|source| ConfigError::Parse {
            path: dir.to_path_buf(),
            source,
        })?;
        Ok(config_from_file(file))
    }

    pub fn load_from_path(path: &Path) -> Result<Self, ConfigError> {
        if path.is_dir() {
            return Self::load_from_directory(path);
        }
        let contents = std::fs::read_to_string(path).map_err(|source| ConfigError::Read {
            path: path.to_path_buf(),
            source,
        })?;
        let file: ConfigFile = toml::from_str(&contents).map_err(|source| ConfigError::Parse {
            path: path.to_path_buf(),
            source,
        })?;
        Ok(config_from_file(file))
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

enum ConfigLocation {
    Directory(PathBuf),
    File(PathBuf),
}

fn config_location() -> Result<ConfigLocation, ConfigError> {
    if let Ok(raw) = std::env::var("OCTO_CONFIG") {
        let path = PathBuf::from(raw);
        if path.is_dir() {
            return Ok(ConfigLocation::Directory(path));
        }
        return Ok(ConfigLocation::File(path));
    }
    let dir = PathBuf::from("config");
    if dir.is_dir() {
        return Ok(ConfigLocation::Directory(dir));
    }
    let file = PathBuf::from("config.toml");
    if file.is_file() {
        return Ok(ConfigLocation::File(file));
    }
    Ok(ConfigLocation::Directory(dir))
}

fn merge_tables(into: &mut Map<String, Value>, from: Map<String, Value>) {
    for (key, value) in from {
        if let Value::Table(incoming) = value {
            match into.get_mut(&key) {
                Some(Value::Table(existing)) => {
                    merge_tables(existing, incoming);
                    continue;
                }
                None | Some(_) => {
                    into.insert(key, Value::Table(incoming));
                }
            }
        } else {
            into.insert(key, value);
        }
    }
}

fn config_from_file(file: ConfigFile) -> Config {
    Config {
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
    }
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
    #[error("config fragment at {path} must be a TOML table")]
    InvalidFragment { path: PathBuf },
    #[error("failed to serialize merged config at {path}")]
    Serialize {
        path: PathBuf,
        #[source]
        source: toml::ser::Error,
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
        "bind_addr {addr} is not loopback; set allow_remote = true in config/server.toml"
    )]
    RemoteBindNotAllowed { addr: String },
}
