use axum::{
    body::Body,
    http::{Request, Response},
};
use reqwest::Client;

use crate::config::{Config, ConfigError};
use crate::proxy::error::ProxyError;

use super::openrouter::OpenRouter;
use super::traits::DecisionsForward;

#[derive(Clone)]
pub enum DecisionsBackend {
    OpenRouter(OpenRouter),
}

impl DecisionsForward for DecisionsBackend {
    fn upstream_url(&self) -> &str {
        match self {
            Self::OpenRouter(provider) => provider.upstream_url(),
        }
    }

    fn forward_decisions(
        &self,
        client: &Client,
        request: Request<Body>,
    ) -> impl std::future::Future<Output = Result<Response<Body>, ProxyError>> + Send {
        let provider = match self {
            Self::OpenRouter(provider) => provider.clone(),
        };
        async move { provider.forward_decisions(client, request).await }
    }
}

pub fn decisions_from_config(config: &Config) -> Result<DecisionsBackend, ConfigError> {
    match config.decision_backend.as_str() {
        "openrouter" => Ok(DecisionsBackend::OpenRouter(OpenRouter::new(
            config.openrouter_decisions_url.clone(),
            config.openrouter_http_referer.clone(),
            config.openrouter_title.clone(),
            config.max_body_bytes,
        ))),
        other => Err(ConfigError::UnknownBackend {
            kind: "decision",
            name: other.to_string(),
        }),
    }
}

#[derive(Clone)]
pub struct Providers<D> {
    pub decisions: D,
}

pub type Wired = Providers<DecisionsBackend>;

impl Wired {
    pub fn from_config(config: &Config) -> Result<Self, ConfigError> {
        Ok(Self {
            decisions: decisions_from_config(config)?,
        })
    }
}
