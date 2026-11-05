use std::time::{Duration, Instant};

use crate::providers::openrouter::OpenRouterModels;

use super::jev::Complexity;
use super::metrics;

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
                Some(preferred)
                    if !ids_match(preferred, &self.low) && !ids_match(preferred, &self.mid) =>
                {
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

/// OpenRouter preferred-model prefix; catalog ids are stored without it.
pub fn bare_id(slug: &str) -> &str {
    slug.trim_start_matches('~')
}

pub fn ids_match(left: &str, right: &str) -> bool {
    left == right || bare_id(left) == bare_id(right)
}

pub fn context_length(models: Option<&OpenRouterModels>, slug: &str) -> u64 {
    let Some(models) = models else {
        return 8192;
    };
    models
        .free
        .iter()
        .chain(models.paid.iter())
        .find(|model| ids_match(&model.id, slug))
        .and_then(|model| model.context_length)
        .unwrap_or(8192)
}

pub struct LargerFit<'a> {
    pub candidates: &'a [&'a str],
    pub models: Option<&'a OpenRouterModels>,
    pub input_tokens: u64,
    pub max_tokens: u64,
    pub current: &'a str,
}

/// Smallest window among tier candidates that still fits and is larger than `current`.
pub fn larger_fit(plan: LargerFit<'_>) -> Option<String> {
    let current_window = context_length(plan.models, plan.current);
    plan.candidates
        .iter()
        .copied()
        .filter_map(|slug| {
            if ids_match(slug, plan.current) {
                return None;
            }
            let window = context_length(plan.models, slug);
            let usable = window.saturating_sub(metrics::output_reserve(window, plan.max_tokens));
            (window > current_window && usable >= plan.input_tokens)
                .then(|| (window, slug.to_string()))
        })
        .min_by_key(|(window, _)| *window)
        .map(|(_, slug)| slug)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::providers::openrouter::OpenRouterModel;

    fn paid(id: &str, context_length: u64) -> OpenRouterModel {
        OpenRouterModel {
            id: id.to_string(),
            name: id.to_string(),
            is_free: false,
            context_length: Some(context_length),
        }
    }

    fn catalog(models: Vec<OpenRouterModel>) -> OpenRouterModels {
        OpenRouterModels {
            free: Vec::new(),
            paid: models,
        }
    }

    #[test]
    fn context_length_matches_tilde_preferred_slug() {
        let models = catalog(vec![paid("anthropic/claude-haiku-latest", 200_000)]);
        assert_eq!(
            context_length(Some(&models), "~anthropic/claude-haiku-latest"),
            200_000
        );
        assert_eq!(
            context_length(Some(&models), "anthropic/claude-haiku-latest"),
            200_000
        );
    }

    #[test]
    fn larger_fit_picks_smallest_larger_window_not_first_tier() {
        let models = catalog(vec![
            paid("low-model", 32_000),
            paid("mid-model", 64_000),
            paid("anthropic/claude-haiku-latest", 200_000),
        ]);
        let candidates = ["low-model", "mid-model", "~anthropic/claude-haiku-latest"];
        let chosen = larger_fit(LargerFit {
            candidates: &candidates,
            models: Some(&models),
            input_tokens: 40_000,
            max_tokens: 4096,
            current: "low-model",
        });
        assert_eq!(chosen.as_deref(), Some("mid-model"));
    }

    #[test]
    fn larger_fit_does_not_downgrade_high_tilde_to_low() {
        let models = catalog(vec![
            paid("google/gemma", 128_000),
            paid("deepseek/flash", 64_000),
            paid("anthropic/claude-haiku-latest", 200_000),
        ]);
        let candidates = [
            "google/gemma",
            "deepseek/flash",
            "~anthropic/claude-haiku-latest",
        ];
        let chosen = larger_fit(LargerFit {
            candidates: &candidates,
            models: Some(&models),
            input_tokens: 50_000,
            max_tokens: 4096,
            current: "~anthropic/claude-haiku-latest",
        });
        assert_eq!(chosen, None);
        assert_eq!(
            context_length(Some(&models), "~anthropic/claude-haiku-latest"),
            200_000
        );
    }
}
