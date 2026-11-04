use std::time::{Duration, Instant};

use reqwest::Client;

use crate::providers::openrouter::{fetch_models, OpenRouterModels, DEFAULT_MODELS_URL};

pub const LOW_MODEL: &str = "google/gemma-4-26b-a4b-it";
pub const MID_MODEL: &str = "deepseek/deepseek-v4-flash";
pub const HIGH_MODEL: &str = "~anthropic/claude-haiku-latest";

#[derive(Debug, Default)]
pub struct CatalogCache {
    fetched: Option<(Instant, OpenRouterModels)>,
    ttl: Duration,
}

impl CatalogCache {
    pub fn new(ttl: Duration) -> Self {
        Self { fetched: None, ttl }
    }

    pub async fn models(&mut self, client: &Client, api_key: &str) -> Option<OpenRouterModels> {
        if let Some((at, models)) = &self.fetched {
            if at.elapsed() < self.ttl {
                return Some(models.clone());
            }
        }
        let models = fetch_models(client, DEFAULT_MODELS_URL, Some(api_key))
            .await
            .ok()?;
        self.fetched = Some((Instant::now(), models.clone()));
        Some(models)
    }
}

pub fn context_length(models: Option<&OpenRouterModels>, slug: &str) -> u64 {
    let Some(models) = models else {
        return 8192;
    };
    models
        .free
        .iter()
        .chain(models.paid.iter())
        .find(|model| model.id == slug)
        .and_then(|model| model.context_length)
        .unwrap_or(8192)
}

pub fn pick_model(complexity: crate::auto::jev::Complexity, preferred: Option<&str>) -> String {
    let tier = match complexity {
        crate::auto::jev::Complexity::Low => LOW_MODEL,
        crate::auto::jev::Complexity::Mid => MID_MODEL,
        crate::auto::jev::Complexity::High => preferred.unwrap_or(HIGH_MODEL),
    };
    if complexity == crate::auto::jev::Complexity::High {
        if let Some(preferred) = preferred {
            if preferred == LOW_MODEL || preferred == MID_MODEL {
                return HIGH_MODEL.to_string();
            }
            return preferred.to_string();
        }
    }
    if complexity == crate::auto::jev::Complexity::Low {
        return LOW_MODEL.to_string();
    }
    if let Some(preferred) = preferred {
        if preferred != LOW_MODEL {
            return preferred.to_string();
        }
    }
    tier.to_string()
}

pub fn larger_fit<'a>(
    candidates: &'a [&'a str],
    models: Option<&OpenRouterModels>,
    input_tokens: u64,
    max_tokens: u64,
    current: &str,
) -> Option<&'a str> {
    candidates.iter().copied().find(|slug| {
        *slug != current && context_length(models, slug).saturating_sub(max_tokens) >= input_tokens
    })
}
