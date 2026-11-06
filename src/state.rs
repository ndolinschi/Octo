use std::time::Duration;

use reqwest::Client;

use crate::auto::{Auto, Tiers};
use crate::config::{Config, ConfigError};
use crate::history::History;
use crate::providers::{decision, llm};
use crate::proxy::select::{self, ChatCompatProvider, MessagesProvider};

fn session_budget_micros(usd: f64) -> u64 {
    if !usd.is_finite() || usd <= 0.0 {
        0
    } else {
        (usd * 1_000_000.0).round() as u64
    }
}

#[derive(Clone)]
pub struct AppState {
    pub client: Client,
    pub config: Config,
    pub default_chat_provider: ChatCompatProvider,
    pub default_messages_provider: MessagesProvider,
    pub llm: llm::Providers,
    pub decision: decision::Providers,
    pub history: History,
    pub auto: Auto,
}

impl AppState {
    pub fn new(config: Config) -> Result<Self, AppStateError> {
        let default_chat_provider = select::chat_compat_from_llm_backend(&config.llm_chat_backend)
            .ok_or_else(|| ConfigError::UnknownBackend {
                kind: "llm.chat",
                name: config.llm_chat_backend.clone(),
            })?;
        let default_messages_provider = select::parse_messages_provider_token(
            &config.llm_messages_backend,
        )
        .ok_or_else(|| ConfigError::UnknownBackend {
            kind: "llm.messages",
            name: config.llm_messages_backend.clone(),
        })?;
        let connect_timeout = Duration::from_secs(config.upstream_connect_timeout_secs);
        let request_timeout = Duration::from_secs(config.upstream_request_timeout_secs);
        Ok(Self {
            client: Client::builder()
                .connect_timeout(connect_timeout)
                .timeout(request_timeout)
                .build()?,
            default_chat_provider,
            default_messages_provider,
            llm: llm::Providers::from_config(&config),
            decision: decision::Providers::from_config(&config)?,
            history: History::disabled(),
            auto: Auto::new({
                let mut tiers = Tiers::new(
                    config.autoroute_low_model.clone(),
                    config.autoroute_mid_model.clone(),
                    config.autoroute_high_model.clone(),
                );
                tiers.hard_threshold = config.autoroute_hard_threshold;
                tiers.easy_threshold = config.autoroute_easy_threshold;
                tiers.stall_window = config.autoroute_stall_window;
                tiers.escalate_turns = config.autoroute_escalate_turns;
                tiers.down_confirm = config.autoroute_down_confirm;
                tiers.high_allow = config.autoroute_high_allow.clone();
                tiers.session_budget_micros =
                    session_budget_micros(config.autoroute_session_budget_usd);
                tiers.housekeeping_keep_messages = config.autoroute_housekeeping_keep_messages;
                tiers.provider_order = config.autoroute_provider_order.clone();
                tiers.allow_fallbacks = config.autoroute_allow_fallbacks;
                tiers.background_by_client_model = config.autoroute_background_by_client_model;
                tiers.background_model_patterns =
                    config.autoroute_background_model_patterns.clone();
                tiers
            }),
            config,
        })
    }
}

#[derive(Debug, thiserror::Error)]
pub enum AppStateError {
    #[error(transparent)]
    Config(#[from] ConfigError),
    #[error(transparent)]
    Client(#[from] reqwest::Error),
}
