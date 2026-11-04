use std::time::{Duration, Instant};

use crate::providers::openrouter::OpenRouterModels;

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

    pub fn fresh(&self) -> Option<OpenRouterModels> {
        self.fetched
            .as_ref()
            .and_then(|(at, models)| (at.elapsed() < self.ttl).then(|| models.clone()))
    }

    pub fn store(&mut self, models: OpenRouterModels) {
        self.fetched = Some((Instant::now(), models));
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
    match complexity {
        crate::auto::jev::Complexity::Low => LOW_MODEL.to_string(),
        crate::auto::jev::Complexity::Mid => MID_MODEL.to_string(),
        crate::auto::jev::Complexity::High => match preferred {
            Some(preferred) if preferred != LOW_MODEL && preferred != MID_MODEL => {
                preferred.to_string()
            }
            _ => HIGH_MODEL.to_string(),
        },
    }
}

pub fn larger_fit<'a>(
    candidates: &'a [&'a str],
    models: Option<&OpenRouterModels>,
    input_tokens: u64,
    max_tokens: u64,
    current: &str,
) -> Option<&'a str> {
    let current_window = context_length(models, current);
    candidates.iter().copied().find(|slug| {
        let window = context_length(models, slug);
        window > current_window
            && window.saturating_sub(super::metrics::output_reserve(window, max_tokens))
                >= input_tokens
    })
}
