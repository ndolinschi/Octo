use std::time::{Duration, Instant};

use crate::providers::openrouter::OpenRouterModels;

use super::jev::Complexity;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Tiers {
    pub low: String,
    pub mid: String,
    pub high: String,
}

impl Tiers {
    pub fn new(low: String, mid: String, high: String) -> Self {
        Self { low, mid, high }
    }

    pub fn candidates(&self) -> [&str; 3] {
        [self.low.as_str(), self.mid.as_str(), self.high.as_str()]
    }

    pub fn pick(&self, complexity: Complexity, preferred: Option<&str>) -> String {
        match complexity {
            Complexity::Low => self.low.clone(),
            Complexity::Mid => self.mid.clone(),
            Complexity::High => match preferred {
                Some(preferred) if preferred != self.low && preferred != self.mid => {
                    preferred.to_string()
                }
                _ => self.high.clone(),
            },
        }
    }
}

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

pub fn larger_fit(
    candidates: &[&str],
    models: Option<&OpenRouterModels>,
    input_tokens: u64,
    max_tokens: u64,
    current: &str,
) -> Option<String> {
    let current_window = context_length(models, current);
    candidates
        .iter()
        .copied()
        .find(|slug| {
            let window = context_length(models, slug);
            window > current_window
                && window.saturating_sub(super::metrics::output_reserve(window, max_tokens))
                    >= input_tokens
        })
        .map(str::to_string)
}
