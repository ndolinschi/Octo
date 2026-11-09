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
    "history.toml",
    "autoroute.toml",
    "prices.toml",
];

#[derive(Clone, Debug)]
pub struct Config {
    pub bind_addr: String,
    pub allow_remote: bool,
    pub client_auth_key: String,
    pub upstream_connect_timeout_secs: u64,
    pub upstream_request_timeout_secs: u64,
    pub openai_chat_completions_url: String,
    pub openrouter_chat_completions_url: String,
    pub openrouter_chat_completions_path: String,
    pub openrouter_decisions_url: String,
    pub openrouter_decisions_path: String,
    pub openrouter_http_referer: Option<String>,
    pub openrouter_title: Option<String>,
    pub openrouter_messages_url: String,
    pub openrouter_messages_path: String,
    pub anthropic_messages_url: String,
    pub anthropic_api_version: String,
    pub anthropic_messages_path: String,
    pub max_body_bytes: usize,
    pub llm_chat_backend: String,
    pub llm_messages_backend: String,
    pub decision_backend: String,
    pub history_database_path: String,
    pub history_token_key: String,
    pub history_store_payloads: bool,
    pub autoroute_low_model: String,
    pub autoroute_mid_model: String,
    pub autoroute_high_model: String,
    pub autoroute_hard_threshold: f64,
    pub autoroute_easy_threshold: f64,
    pub autoroute_stall_window: u32,
    pub autoroute_escalate_turns: u32,
    pub autoroute_down_confirm: u32,
    pub autoroute_high_allow: Vec<String>,
    pub autoroute_session_budget_usd: f64,
    pub autoroute_housekeeping_keep_messages: u32,
    pub autoroute_provider_order: Vec<String>,
    pub autoroute_allow_fallbacks: bool,
    pub autoroute_strip_fields: Vec<String>,
    pub autoroute_require_parameters: String,
    pub autoroute_background_model_patterns: Vec<String>,
    pub autoroute_background_by_client_model: bool,
    pub autoroute_server_tool_mode: String,
    pub prices: crate::history::PriceTable,
}

#[derive(Clone, Debug, Deserialize)]
struct ConfigFile {
    server: ServerSection,
    #[serde(default)]
    upstream: UpstreamSection,
    limits: LimitsSection,
    #[serde(default)]
    openai: OpenAiSection,
    #[serde(default)]
    openrouter: OpenRouterSection,
    #[serde(default)]
    llm: LlmSection,
    #[serde(default)]
    decision: DecisionSection,
    #[serde(default)]
    anthropic: AnthropicSection,
    #[serde(default)]
    history: HistorySection,
    #[serde(default)]
    autoroute: AutorouteSection,
    #[serde(default)]
    prices: std::collections::HashMap<String, PriceRow>,
}

#[derive(Clone, Debug, Deserialize)]
struct ServerSection {
    bind_addr: String,
    #[serde(default)]
    allow_remote: bool,
    #[serde(default)]
    client_auth_key: String,
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
    #[serde(default = "default_openrouter_chat_completions_url")]
    chat_completions_url: String,
    #[serde(default = "default_openrouter_chat_completions_path")]
    chat_completions_path: String,
    #[serde(default = "default_decisions_url")]
    decisions_url: String,
    #[serde(default = "default_decisions_path")]
    decisions_path: String,
    #[serde(default)]
    http_referer: Option<String>,
    #[serde(default)]
    openrouter_title: Option<String>,
    #[serde(default = "default_openrouter_messages_url")]
    messages_url: String,
    #[serde(default = "default_openrouter_messages_path")]
    messages_path: String,
}

fn default_openrouter_chat_completions_url() -> String {
    "https://openrouter.ai/api/v1/chat/completions".to_string()
}

fn default_openrouter_chat_completions_path() -> String {
    "/v1/chat/completions".to_string()
}

fn default_openrouter_messages_url() -> String {
    "https://openrouter.ai/api/v1/messages".to_string()
}

fn default_openrouter_messages_path() -> String {
    "/v1/messages".to_string()
}

impl Default for OpenRouterSection {
    fn default() -> Self {
        Self {
            chat_completions_url: default_openrouter_chat_completions_url(),
            chat_completions_path: default_openrouter_chat_completions_path(),
            decisions_url: default_decisions_url(),
            decisions_path: default_decisions_path(),
            http_referer: None,
            openrouter_title: None,
            messages_url: default_openrouter_messages_url(),
            messages_path: default_openrouter_messages_path(),
        }
    }
}

fn default_decisions_url() -> String {
    "https://openrouter.ai/api/alpha/decisions".to_string()
}

fn default_decisions_path() -> String {
    "/v1/decisions".to_string()
}

#[derive(Clone, Debug, Deserialize)]
struct AnthropicSection {
    #[serde(default = "default_anthropic_messages_url")]
    messages_url: String,
    #[serde(default = "default_anthropic_messages_path")]
    messages_path: String,
    #[serde(default = "default_anthropic_api_version")]
    api_version: String,
}

fn default_anthropic_messages_url() -> String {
    "https://api.anthropic.com/v1/messages".to_string()
}

fn default_anthropic_messages_path() -> String {
    "/v1/messages".to_string()
}

fn default_anthropic_api_version() -> String {
    "2023-06-01".to_string()
}

impl Default for AnthropicSection {
    fn default() -> Self {
        Self {
            messages_url: default_anthropic_messages_url(),
            messages_path: default_anthropic_messages_path(),
            api_version: default_anthropic_api_version(),
        }
    }
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

#[derive(Clone, Debug, Deserialize)]
struct HistorySection {
    #[serde(default = "default_history_database_path")]
    database_path: String,
    #[serde(default)]
    token_key: String,
    #[serde(default = "default_history_store_payloads")]
    store_payloads: bool,
}

impl Default for HistorySection {
    fn default() -> Self {
        Self {
            database_path: default_history_database_path(),
            token_key: String::new(),
            store_payloads: default_history_store_payloads(),
        }
    }
}

fn default_history_store_payloads() -> bool {
    true
}

fn default_history_database_path() -> String {
    "data/history.sqlite".to_string()
}

#[derive(Clone, Debug, Deserialize)]
struct AutorouteSection {
    #[serde(default = "default_autoroute_low_model")]
    low: String,
    #[serde(default = "default_autoroute_mid_model")]
    mid: String,
    #[serde(default = "default_autoroute_high_model")]
    high: String,
    #[serde(default = "default_autoroute_hard_threshold")]
    hard_threshold: f64,
    #[serde(default = "default_autoroute_easy_threshold")]
    easy_threshold: f64,
    #[serde(default = "default_autoroute_stall_window")]
    stall_window: u32,
    #[serde(default = "default_autoroute_escalate_turns")]
    escalate_turns: u32,
    #[serde(default = "default_autoroute_down_confirm")]
    down_confirm: u32,
    #[serde(default)]
    high_allow: Vec<String>,
    #[serde(default = "default_autoroute_session_budget_usd")]
    session_budget_usd: f64,
    #[serde(default = "default_autoroute_housekeeping_keep_messages")]
    housekeeping_keep_messages: u32,
    #[serde(default)]
    provider_order: Vec<String>,
    #[serde(default = "default_autoroute_allow_fallbacks")]
    allow_fallbacks: bool,
    #[serde(default = "default_autoroute_strip_fields")]
    strip_fields: Vec<String>,
    #[serde(default = "default_autoroute_require_parameters")]
    require_parameters: String,
    #[serde(default = "default_autoroute_background_model_patterns")]
    background_model_patterns: Vec<String>,
    #[serde(default)]
    background_by_client_model: bool,
    #[serde(default = "default_autoroute_server_tool_mode")]
    server_tool_mode: String,
}

impl Default for AutorouteSection {
    fn default() -> Self {
        Self {
            low: default_autoroute_low_model(),
            mid: default_autoroute_mid_model(),
            high: default_autoroute_high_model(),
            hard_threshold: default_autoroute_hard_threshold(),
            easy_threshold: default_autoroute_easy_threshold(),
            stall_window: default_autoroute_stall_window(),
            escalate_turns: default_autoroute_escalate_turns(),
            down_confirm: default_autoroute_down_confirm(),
            high_allow: Vec::new(),
            session_budget_usd: default_autoroute_session_budget_usd(),
            housekeeping_keep_messages: default_autoroute_housekeeping_keep_messages(),
            provider_order: Vec::new(),
            allow_fallbacks: default_autoroute_allow_fallbacks(),
            strip_fields: default_autoroute_strip_fields(),
            require_parameters: default_autoroute_require_parameters(),
            background_model_patterns: default_autoroute_background_model_patterns(),
            background_by_client_model: false,
            server_tool_mode: default_autoroute_server_tool_mode(),
        }
    }
}

fn default_autoroute_session_budget_usd() -> f64 {
    0.0
}

fn default_autoroute_housekeeping_keep_messages() -> u32 {
    6
}

fn default_autoroute_allow_fallbacks() -> bool {
    true
}

fn default_autoroute_strip_fields() -> Vec<String> {
    crate::auto::default_strip_fields()
}

fn default_autoroute_require_parameters() -> String {
    "always".to_string()
}

fn default_autoroute_background_model_patterns() -> Vec<String> {
    vec!["haiku".to_string()]
}

fn default_autoroute_server_tool_mode() -> String {
    "passthrough".to_string()
}

#[derive(Clone, Debug, Deserialize, Default)]
struct PriceRow {
    input: Option<f64>,
    cache_read: Option<f64>,
    cache_write: Option<f64>,
    output: Option<f64>,
    #[serde(default)]
    billed_as: Option<String>,
}

fn default_autoroute_low_model() -> String {
    "mistralai/mistral-nemo".to_string()
}

fn default_autoroute_mid_model() -> String {
    "mistralai/mistral-small-3.2-24b-instruct".to_string()
}

fn default_autoroute_high_model() -> String {
    "deepseek/deepseek-v4-flash".to_string()
}

fn default_autoroute_hard_threshold() -> f64 {
    0.5
}

fn default_autoroute_easy_threshold() -> f64 {
    0.5
}

fn default_autoroute_stall_window() -> u32 {
    6
}

fn default_autoroute_escalate_turns() -> u32 {
    3
}

fn default_autoroute_down_confirm() -> u32 {
    2
}

impl Config {
    pub fn load() -> Result<Self, ConfigError> {
        match config_location()? {
            ConfigLocation::Directory(dir) => Self::load_from_directory(&dir),
            ConfigLocation::File(path) => Self::load_from_path(&path),
        }
    }

    pub fn load_from_directory(dir: &Path) -> Result<Self, ConfigError> {
        use std::io::ErrorKind;

        let mut merged = Map::new();
        for name in CONFIG_DIR_FILES {
            let path = dir.join(name);
            let contents = match std::fs::read_to_string(&path) {
                Ok(contents) => contents,
                Err(source) if source.kind() == ErrorKind::NotFound => continue,
                Err(source) => {
                    return Err(ConfigError::Read {
                        path: path.clone(),
                        source,
                    });
                }
            };
            let table: Value = toml::from_str(&contents).map_err(|source| ConfigError::Parse {
                path: path.clone(),
                source,
            })?;
            let Value::Table(table) = table else {
                return Err(ConfigError::InvalidFragment { path });
            };
            merge_tables(&mut merged, table);
        }
        let file: ConfigFile =
            Value::Table(merged)
                .try_into()
                .map_err(|source| ConfigError::Parse {
                    path: dir.to_path_buf(),
                    source,
                })?;
        config_from_file(file)
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
        config_from_file(file)
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
        if !addr.ip().is_loopback() && self.client_auth_key.trim().is_empty() {
            return Err(ConfigError::RemoteBindNeedsAuthKey {
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

fn config_from_file(file: ConfigFile) -> Result<Config, ConfigError> {
    if crate::auto::RequireParameters::parse(&file.autoroute.require_parameters).is_none() {
        return Err(ConfigError::InvalidAutorouteRequireParameters {
            value: file.autoroute.require_parameters,
        });
    }
    for key in &file.autoroute.strip_fields {
        if crate::auto::PROTECTED_STRIP_FIELDS
            .iter()
            .any(|protected| protected.eq_ignore_ascii_case(key))
        {
            tracing::warn!(
                key,
                "autoroute.strip_fields ignores protected key (tools/tool_choice/system/messages/max_tokens/stop_sequences/metadata)"
            );
        }
    }
    Ok(Config {
        bind_addr: file.server.bind_addr,
        allow_remote: file.server.allow_remote,
        client_auth_key: file.server.client_auth_key,
        upstream_connect_timeout_secs: file.upstream.connect_timeout_secs,
        upstream_request_timeout_secs: file.upstream.request_timeout_secs,
        openai_chat_completions_url: file.openai.chat_completions_url,
        openrouter_chat_completions_url: file.openrouter.chat_completions_url,
        openrouter_chat_completions_path: file.openrouter.chat_completions_path,
        openrouter_decisions_url: file.openrouter.decisions_url,
        openrouter_decisions_path: file.openrouter.decisions_path,
        openrouter_http_referer: file.openrouter.http_referer,
        openrouter_title: file.openrouter.openrouter_title,
        openrouter_messages_url: file.openrouter.messages_url,
        openrouter_messages_path: file.openrouter.messages_path,
        anthropic_messages_url: file.anthropic.messages_url,
        anthropic_api_version: file.anthropic.api_version,
        anthropic_messages_path: file.anthropic.messages_path,
        max_body_bytes: file.limits.max_body_bytes,
        llm_chat_backend: file.llm.chat.backend,
        llm_messages_backend: file.llm.messages.backend,
        decision_backend: file.decision.backend,
        history_database_path: file.history.database_path,
        history_token_key: file.history.token_key,
        history_store_payloads: file.history.store_payloads,
        autoroute_low_model: file.autoroute.low,
        autoroute_mid_model: file.autoroute.mid,
        autoroute_high_model: file.autoroute.high,
        autoroute_hard_threshold: file.autoroute.hard_threshold,
        autoroute_easy_threshold: file.autoroute.easy_threshold,
        autoroute_stall_window: file.autoroute.stall_window,
        autoroute_escalate_turns: file.autoroute.escalate_turns,
        autoroute_down_confirm: file.autoroute.down_confirm,
        autoroute_high_allow: file.autoroute.high_allow,
        autoroute_session_budget_usd: file.autoroute.session_budget_usd,
        autoroute_housekeeping_keep_messages: file.autoroute.housekeeping_keep_messages,
        autoroute_provider_order: file.autoroute.provider_order,
        autoroute_allow_fallbacks: file.autoroute.allow_fallbacks,
        autoroute_strip_fields: file.autoroute.strip_fields,
        autoroute_require_parameters: file.autoroute.require_parameters,
        autoroute_background_model_patterns: file.autoroute.background_model_patterns,
        autoroute_background_by_client_model: file.autoroute.background_by_client_model,
        autoroute_server_tool_mode: file.autoroute.server_tool_mode,
        prices: {
            use crate::history::{ModelPrice, PriceTable};
            let rows = file
                .prices
                .into_iter()
                .map(|(slug, row)| {
                    let rates_complete = row.input.is_some()
                        && row.cache_read.is_some()
                        && row.cache_write.is_some()
                        && row.output.is_some();
                    (
                        slug,
                        ModelPrice {
                            input: row.input.unwrap_or(0.0),
                            cache_read: row.cache_read.unwrap_or(0.0),
                            cache_write: row.cache_write.unwrap_or(0.0),
                            output: row.output.unwrap_or(0.0),
                            billed_as: row.billed_as,
                            rates_complete,
                        },
                    )
                })
                .collect();
            PriceTable::new(rows)
        },
    })
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
    #[error("unknown {kind} backend {name}")]
    UnknownBackend { kind: &'static str, name: String },
    #[error(
        "invalid autoroute.require_parameters {value:?}; expected always, tools_only, or never"
    )]
    InvalidAutorouteRequireParameters { value: String },
    #[error("invalid bind_addr {addr}")]
    InvalidBindAddr {
        addr: String,
        #[source]
        source: std::net::AddrParseError,
    },
    #[error("bind_addr {addr} is not loopback; set allow_remote = true in config/server.toml")]
    RemoteBindNotAllowed { addr: String },
    #[error(
        "bind_addr {addr} is not loopback and no client_auth_key is set; refuse to start without a key"
    )]
    RemoteBindNeedsAuthKey { addr: String },
}
