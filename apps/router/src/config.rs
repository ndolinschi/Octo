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

/// Shipped files compiled into the binary. A config directory that lacks one of them (the desktop shell writes only
/// `server.toml`, `limits.toml` and `history.toml`) is completed from this text; a file on disk always wins.
const EMBEDDED_DEFAULTS: &[(&str, &str)] = &[
    ("openrouter.toml", include_str!("../config/openrouter.toml")),
    ("autoroute.toml", include_str!("../config/autoroute.toml")),
    ("prices.toml", include_str!("../config/prices.toml")),
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
    pub ollama_base_url: String,
    pub max_body_bytes: usize,
    pub llm_chat_backend: String,
    pub llm_messages_backend: String,
    pub decision_backend: String,
    pub history_database_path: String,
    pub history_token_key: String,
    pub history_store_payloads: bool,
    pub history_calls_max_age_days: u64,
    pub history_calls_max_rows: u64,
    pub history_budget_spend_max_age_days: u64,
    pub history_prune_interval_secs: u64,
    pub autoroute_small_model: String,
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
    pub autoroute_compact_cooldown_requests: u32,
    pub autoroute_classifier_failure_tier: String,
    pub autoroute_default_max_tokens: u64,
    pub autoroute_retry_after_max_secs: u64,
    pub autoroute_session_budget_action: String,
    pub autoroute_never_pay_more_for_less: bool,
    pub autoroute_route: crate::auto::RoutePolicy,
    pub autoroute_delegation: crate::auto::DelegationSettings,
    /// `prices.toml` rows: `source = "manual"` rows are overrides, the rest are fallback values.
    pub prices: crate::history::PriceTable,
    /// `[prices]` scalar keys: catalogue refresh settings.
    pub price_refresh: crate::prices::RefreshSettings,
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
    ollama: OllamaSection,
    #[serde(default)]
    history: HistorySection,
    #[serde(default)]
    autoroute: AutorouteSection,
    #[serde(default)]
    prices: Map<String, Value>,
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
struct OllamaSection {
    #[serde(default = "default_ollama_base_url")]
    base_url: String,
}

fn default_ollama_base_url() -> String {
    "http://127.0.0.1:11434".to_string()
}

impl Default for OllamaSection {
    fn default() -> Self {
        Self {
            base_url: default_ollama_base_url(),
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
    #[serde(default = "default_calls_max_age_days")]
    calls_max_age_days: u64,
    #[serde(default = "default_calls_max_rows")]
    calls_max_rows: u64,
    #[serde(default = "default_budget_spend_max_age_days")]
    budget_spend_max_age_days: u64,
    #[serde(default = "default_prune_interval_secs")]
    prune_interval_secs: u64,
}

impl Default for HistorySection {
    fn default() -> Self {
        Self {
            database_path: default_history_database_path(),
            token_key: String::new(),
            store_payloads: default_history_store_payloads(),
            calls_max_age_days: default_calls_max_age_days(),
            calls_max_rows: default_calls_max_rows(),
            budget_spend_max_age_days: default_budget_spend_max_age_days(),
            prune_interval_secs: default_prune_interval_secs(),
        }
    }
}

fn default_calls_max_age_days() -> u64 {
    30
}

fn default_calls_max_rows() -> u64 {
    100_000
}

fn default_budget_spend_max_age_days() -> u64 {
    90
}

fn default_prune_interval_secs() -> u64 {
    600
}

fn default_history_store_payloads() -> bool {
    true
}

fn default_history_database_path() -> String {
    "data/history.sqlite".to_string()
}

#[derive(Clone, Debug, Deserialize)]
struct AutorouteSection {
    #[serde(default = "default_autoroute_small_model")]
    small: String,
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
    #[serde(default)]
    compact_cooldown_requests: u32,
    #[serde(default = "default_autoroute_classifier_failure_tier")]
    classifier_failure_tier: String,
    #[serde(default = "default_autoroute_default_max_tokens")]
    default_max_tokens: u64,
    #[serde(default = "default_autoroute_retry_after_max_secs")]
    retry_after_max_secs: u64,
    #[serde(default = "default_autoroute_session_budget_action")]
    session_budget_action: String,
    #[serde(default = "default_autoroute_never_pay_more_for_less")]
    never_pay_more_for_less: bool,
    #[serde(default)]
    route: crate::auto::RoutePolicy,
    #[serde(default)]
    delegation: crate::auto::DelegationSettings,
}

impl Default for AutorouteSection {
    fn default() -> Self {
        Self {
            small: default_autoroute_small_model(),
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
            compact_cooldown_requests: 0,
            classifier_failure_tier: default_autoroute_classifier_failure_tier(),
            default_max_tokens: default_autoroute_default_max_tokens(),
            retry_after_max_secs: default_autoroute_retry_after_max_secs(),
            session_budget_action: default_autoroute_session_budget_action(),
            never_pay_more_for_less: default_autoroute_never_pay_more_for_less(),
            route: crate::auto::RoutePolicy::default(),
            delegation: crate::auto::DelegationSettings::default(),
        }
    }
}

fn default_autoroute_never_pay_more_for_less() -> bool {
    true
}

fn default_autoroute_classifier_failure_tier() -> String {
    "mid".to_string()
}

fn default_autoroute_default_max_tokens() -> u64 {
    8192
}

fn default_autoroute_retry_after_max_secs() -> u64 {
    10
}

fn default_autoroute_session_budget_action() -> String {
    "downgrade".to_string()
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
    #[serde(default)]
    source: Option<String>,
}

fn default_autoroute_small_model() -> String {
    "qwen2.5-coder:1.5b".to_string()
}

fn default_autoroute_low_model() -> String {
    "deepseek/deepseek-v4.1-flash".to_string()
}

fn default_autoroute_mid_model() -> String {
    "minimax/minimax-m3.1-flash".to_string()
}

fn default_autoroute_high_model() -> String {
    "deepseek/deepseek-v4.1-flash-1017".to_string()
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
        Self::load_with_report().map(|(config, _)| config)
    }

    /// Like [`Config::load`], also naming the files that came from the embedded defaults (empty for a legacy
    /// single-file config).
    pub fn load_with_report() -> Result<(Self, Vec<&'static str>), ConfigError> {
        match config_location()? {
            ConfigLocation::Directory(dir) => Self::load_directory_with_report(&dir),
            ConfigLocation::File(path) => {
                Self::load_from_path(&path).map(|config| (config, vec![]))
            }
        }
    }

    pub fn load_from_directory(dir: &Path) -> Result<Self, ConfigError> {
        Self::load_directory_with_report(dir).map(|(config, _)| config)
    }

    /// Loads a config directory; every embedded default file missing from it is used instead and listed in the result.
    pub fn load_directory_with_report(
        dir: &Path,
    ) -> Result<(Self, Vec<&'static str>), ConfigError> {
        use std::io::ErrorKind;

        // Read every file on disk first; the embedded text stands in for the missing embedded ones only.
        let mut on_disk: Vec<(PathBuf, Map<String, Value>)> = Vec::new();
        let mut present: Vec<&str> = Vec::new();
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
            present.push(name);
            on_disk.push((path, table));
        }
        // Embedded fragments go in first and every file on disk after them, so anything on disk wins key by key,
        // whichever fragment it sits in.
        let mut merged = Map::new();
        let mut embedded = Vec::new();
        for (name, text) in EMBEDDED_DEFAULTS {
            if present.contains(name) {
                continue;
            }
            let path = dir.join(name);
            let table: Value = toml::from_str(text).map_err(|source| ConfigError::Parse {
                path: path.clone(),
                source,
            })?;
            let Value::Table(table) = table else {
                return Err(ConfigError::InvalidFragment { path });
            };
            embedded.push(*name);
            merge_tables(&mut merged, table);
        }
        for (_, table) in on_disk {
            merge_tables(&mut merged, table);
        }
        let file: ConfigFile =
            Value::Table(merged)
                .try_into()
                .map_err(|source| ConfigError::Parse {
                    path: dir.to_path_buf(),
                    source,
                })?;
        Ok((config_from_file(file)?, embedded))
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
    if !crate::auto::is_band(&file.autoroute.classifier_failure_tier) {
        return Err(ConfigError::InvalidAutorouteClassifierFailureTier {
            value: file.autoroute.classifier_failure_tier,
        });
    }
    if crate::auto::BudgetAction::parse(&file.autoroute.session_budget_action).is_none() {
        return Err(ConfigError::InvalidAutorouteBudgetAction {
            value: file.autoroute.session_budget_action,
        });
    }
    if file.autoroute.default_max_tokens == 0 {
        return Err(ConfigError::InvalidAutorouteDefaultMaxTokens);
    }
    if file.autoroute.delegation.kind().is_none() {
        return Err(ConfigError::InvalidDelegationClassifier {
            value: file.autoroute.delegation.classifier,
        });
    }
    let (prices, price_refresh) = prices_from_section(file.prices)?;
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
        ollama_base_url: file.ollama.base_url,
        max_body_bytes: file.limits.max_body_bytes,
        llm_chat_backend: file.llm.chat.backend,
        llm_messages_backend: file.llm.messages.backend,
        decision_backend: file.decision.backend,
        history_database_path: file.history.database_path,
        history_token_key: file.history.token_key,
        history_store_payloads: file.history.store_payloads,
        history_calls_max_age_days: file.history.calls_max_age_days,
        history_calls_max_rows: file.history.calls_max_rows,
        history_budget_spend_max_age_days: file.history.budget_spend_max_age_days,
        history_prune_interval_secs: file.history.prune_interval_secs,
        autoroute_small_model: file.autoroute.small,
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
        autoroute_compact_cooldown_requests: file.autoroute.compact_cooldown_requests,
        autoroute_classifier_failure_tier: file.autoroute.classifier_failure_tier,
        autoroute_default_max_tokens: file.autoroute.default_max_tokens,
        autoroute_retry_after_max_secs: file.autoroute.retry_after_max_secs,
        autoroute_session_budget_action: file.autoroute.session_budget_action,
        autoroute_never_pay_more_for_less: file.autoroute.never_pay_more_for_less,
        autoroute_route: file.autoroute.route,
        autoroute_delegation: file.autoroute.delegation,
        prices,
        price_refresh,
    })
}

/// Splits the `[prices]` table: sub-tables are model rows, scalar keys are refresh settings.
fn prices_from_section(
    section: Map<String, Value>,
) -> Result<(crate::history::PriceTable, crate::prices::RefreshSettings), ConfigError> {
    use crate::history::{ModelPrice, PriceSource, PriceTable};
    let mut settings = crate::prices::RefreshSettings::default();
    let mut rows = Vec::new();
    for (key, value) in section {
        match (key.as_str(), value) {
            (_, Value::Table(table)) => {
                let row: PriceRow = Value::Table(table).try_into().map_err(|source| {
                    ConfigError::InvalidPriceRow {
                        slug: key.clone(),
                        source: Box::new(source),
                    }
                })?;
                let source = match row.source.as_deref() {
                    None | Some("fallback") => PriceSource::Fallback,
                    Some("manual") => PriceSource::Manual,
                    Some(other) => {
                        return Err(ConfigError::InvalidPriceSource {
                            slug: key,
                            value: other.to_string(),
                        })
                    }
                };
                let rates_complete = row.input.is_some()
                    && row.cache_read.is_some()
                    && row.cache_write.is_some()
                    && row.output.is_some();
                let price = ModelPrice {
                    input: row.input.unwrap_or(0.0),
                    cache_read: row.cache_read.unwrap_or(0.0),
                    cache_write: row.cache_write.unwrap_or(0.0),
                    output: row.output.unwrap_or(0.0),
                    billed_as: row.billed_as,
                    rates_complete,
                };
                rows.push((key, price, source));
            }
            ("refresh", Value::String(mode)) => {
                settings.refresh = Some(
                    crate::prices::RefreshMode::parse(&mode)
                        .ok_or(ConfigError::InvalidPriceRefresh { value: mode })?,
                );
            }
            ("refresh_interval_secs", Value::Integer(secs)) if secs > 0 => {
                settings.interval_secs = secs as u64;
            }
            ("cache_file", Value::String(path)) => {
                settings.cache_file = (!path.trim().is_empty()).then_some(path);
            }
            (_, value) => {
                return Err(ConfigError::InvalidPriceSetting {
                    key,
                    value: value.to_string(),
                })
            }
        }
    }
    rows.sort_by(|a, b| a.0.cmp(&b.0));
    Ok((PriceTable::with_sources(rows), settings))
}

#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("invalid price row prices.{slug:?}")]
    InvalidPriceRow {
        slug: String,
        #[source]
        source: Box<toml::de::Error>,
    },
    #[error("invalid prices.{slug:?}.source {value:?}; expected manual or fallback")]
    InvalidPriceSource { slug: String, value: String },
    #[error("invalid prices.refresh {value:?}; expected catalogue or off")]
    InvalidPriceRefresh { value: String },
    #[error("invalid prices.{key} = {value}; expected refresh = \"catalogue\"|\"off\", refresh_interval_secs = <seconds > 0>, cache_file = \"<path>\", or a [prices.\"<slug>\"] row")]
    InvalidPriceSetting { key: String, value: String },
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
    #[error("invalid autoroute.classifier_failure_tier {value:?}; expected low, mid, or high")]
    InvalidAutorouteClassifierFailureTier { value: String },
    #[error("invalid autoroute.session_budget_action {value:?}; expected downgrade or reject")]
    InvalidAutorouteBudgetAction { value: String },
    #[error("autoroute.default_max_tokens must be greater than zero")]
    InvalidAutorouteDefaultMaxTokens,
    #[error(
        "invalid autoroute.delegation.classifier {value:?}; expected jev, heuristic, or learned"
    )]
    InvalidDelegationClassifier { value: String },
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
