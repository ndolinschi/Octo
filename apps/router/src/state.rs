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
    /// The live price table (`prices.toml` merged with the catalogue) and its refresh status.
    pub prices: crate::prices::PriceBook,
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
        let prices = crate::prices::PriceBook::from_config(&config);
        let connect_timeout = Duration::from_secs(config.upstream_connect_timeout_secs);
        let request_timeout = Duration::from_secs(config.upstream_request_timeout_secs);
        Ok(Self {
            client: Client::builder()
                .connect_timeout(connect_timeout)
                .read_timeout(request_timeout)
                .timeout(request_timeout)
                .build()?,
            default_chat_provider,
            default_messages_provider,
            llm: llm::Providers::from_config(&config),
            decision: decision::Providers::from_config(&config)?,
            history: History::disabled().with_prices(prices.live()),
            auto: Auto::new({
                let mut tiers = Tiers::new(
                    config.autoroute_low_model.clone(),
                    config.autoroute_mid_model.clone(),
                    config.autoroute_high_model.clone(),
                )
                .with_small(config.autoroute_small_model.clone());
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
                tiers.strip_fields = config.autoroute_strip_fields.clone();
                tiers.require_parameters =
                    crate::auto::RequireParameters::parse(&config.autoroute_require_parameters)
                        .ok_or_else(|| ConfigError::InvalidAutorouteRequireParameters {
                            value: config.autoroute_require_parameters.clone(),
                        })?;
                tiers.background_by_client_model = config.autoroute_background_by_client_model;
                tiers.background_model_patterns =
                    config.autoroute_background_model_patterns.clone();
                tiers.server_tool_mode = config.autoroute_server_tool_mode.clone();
                tiers.compact_cooldown_requests = config.autoroute_compact_cooldown_requests;
                tiers.classifier_failure_tier = config.autoroute_classifier_failure_tier.clone();
                tiers.classifier_timeout_ms = config.autoroute_classifier_timeout_ms;
                tiers.default_max_tokens = config.autoroute_default_max_tokens;
                tiers.retry_after_max_secs = config.autoroute_retry_after_max_secs;
                tiers.session_budget_action =
                    crate::auto::BudgetAction::parse(&config.autoroute_session_budget_action)
                        .unwrap_or(crate::auto::BudgetAction::Downgrade);
                tiers.never_pay_more_for_less = config.autoroute_never_pay_more_for_less;
                tiers.prices = prices.live();
                tiers.route = config.autoroute_route.clone();
                tiers.delegation = config.autoroute_delegation.kind().ok_or_else(|| {
                    ConfigError::InvalidDelegationClassifier {
                        value: config.autoroute_delegation.classifier.clone(),
                    }
                })?;
                tiers
            }),
            config,
            prices,
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
