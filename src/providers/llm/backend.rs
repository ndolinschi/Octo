use axum::{
    body::Body,
    http::{Request, Response},
};
use reqwest::Client;

use crate::config::{Config, ConfigError};
use crate::proxy::error::ProxyError;

use super::anthropic::Anthropic;
use super::openai::OpenAi;
use super::traits::{ChatCompletionsForward, MessagesForward};

#[derive(Clone)]
pub enum ChatCompletionsBackend {
    OpenRouter(OpenAi),
}

impl ChatCompletionsForward for ChatCompletionsBackend {
    fn upstream_url(&self) -> &str {
        match self {
            Self::OpenRouter(provider) => provider.upstream_url(),
        }
    }

    fn forward_chat_completions(
        &self,
        client: &Client,
        request: Request<Body>,
    ) -> impl std::future::Future<Output = Result<Response<Body>, ProxyError>> + Send {
        let provider = match self {
            Self::OpenRouter(provider) => provider.clone(),
        };
        async move { provider.forward_chat_completions(client, request).await }
    }
}

#[derive(Clone)]
pub enum MessagesBackend {
    Anthropic(Anthropic),
}

impl MessagesForward for MessagesBackend {
    fn upstream_url(&self) -> &str {
        match self {
            Self::Anthropic(provider) => provider.upstream_url(),
        }
    }

    fn forward_messages(
        &self,
        client: &Client,
        request: Request<Body>,
    ) -> impl std::future::Future<Output = Result<Response<Body>, ProxyError>> + Send {
        let provider = match self {
            Self::Anthropic(provider) => provider.clone(),
        };
        async move { provider.forward_messages(client, request).await }
    }
}

pub fn chat_from_config(config: &Config) -> Result<ChatCompletionsBackend, ConfigError> {
    match config.llm_chat_backend.as_str() {
        "openrouter" => Ok(ChatCompletionsBackend::OpenRouter(OpenAi::new(
            config.openrouter_chat_completions_url.clone(),
            config.openrouter_http_referer.clone(),
            config.openrouter_title.clone(),
            config.max_body_bytes,
        ))),
        other => Err(ConfigError::UnknownBackend {
            kind: "llm.chat",
            name: other.to_string(),
        }),
    }
}

pub fn messages_from_config(config: &Config) -> Result<MessagesBackend, ConfigError> {
    match config.llm_messages_backend.as_str() {
        "anthropic" => Ok(MessagesBackend::Anthropic(Anthropic::new(
            config.anthropic_messages_url.clone(),
            config.anthropic_api_version.clone(),
            config.max_body_bytes,
        ))),
        other => Err(ConfigError::UnknownBackend {
            kind: "llm.messages",
            name: other.to_string(),
        }),
    }
}

#[derive(Clone)]
pub struct Providers<C, M> {
    pub chat: C,
    pub messages: M,
}

pub type Wired = Providers<ChatCompletionsBackend, MessagesBackend>;

impl Wired {
    pub fn from_config(config: &Config) -> Result<Self, ConfigError> {
        Ok(Self {
            chat: chat_from_config(config)?,
            messages: messages_from_config(config)?,
        })
    }
}
