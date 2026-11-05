use std::time::{Duration, Instant};

use crate::providers::openrouter::OpenRouterModels;

use super::jev::Complexity;
use super::metrics;

#[derive(Clone, Debug, PartialEq)]
pub struct Tiers {
    pub low: String,
    pub mid: String,
    pub high: String,
    pub hard_threshold: f64,
    pub easy_threshold: f64,
    pub stall_window: u32,
    pub escalate_turns: u32,
    pub down_confirm: u32,
    pub high_allow: Vec<String>,
}

impl Tiers {
    pub fn new(low: String, mid: String, high: String) -> Self {
        Self {
            low,
            mid,
            high,
            hard_threshold: 0.5,
            easy_threshold: 0.5,
            stall_window: 6,
            escalate_turns: 3,
            down_confirm: 2,
            high_allow: Vec::new(),
        }
    }

    pub fn candidates(&self) -> [&str; 3] {
        [self.low.as_str(), self.mid.as_str(), self.high.as_str()]
    }

    pub fn band(&self, model: &str) -> &'static str {
        if ids_match(model, &self.low) {
            "low"
        } else if ids_match(model, &self.mid) {
            "mid"
        } else if ids_match(model, &self.high) {
            "high"
        } else {
            "custom"
        }
    }

    pub fn slug(&self, band: &str) -> String {
        match band {
            "low" => self.low.clone(),
            "mid" => self.mid.clone(),
            "high" => self.high.clone(),
            _ => self.mid.clone(),
        }
    }

    pub fn next_up(&self, model: &str) -> Option<String> {
        match self.band(model) {
            "low" => Some(self.mid.clone()),
            "mid" => Some(self.high.clone()),
            _ => None,
        }
    }

    pub fn pick(&self, complexity: Complexity, preferred: Option<&str>) -> String {
        match complexity {
            Complexity::Low => self.low.clone(),
            Complexity::Mid => self.mid.clone(),
            Complexity::High => match preferred {
                Some(preferred)
                    if self.high_allowed(preferred)
                        && !ids_match(preferred, &self.low)
                        && !ids_match(preferred, &self.mid) =>
                {
                    preferred.to_string()
                }
                _ => self.high.clone(),
            },
        }
    }

    fn high_allowed(&self, preferred: &str) -> bool {
        self.high_allow
            .iter()
            .any(|allowed| ids_match(preferred, allowed))
    }
}

pub fn band_rank(band: &str) -> u8 {
    match band {
        "low" => 0,
        "mid" => 1,
        "high" => 2,
        _ => 1,
    }
}

pub fn complexity_band(complexity: Complexity) -> &'static str {
    match complexity {
        Complexity::Low => "low",
        Complexity::Mid => "mid",
        Complexity::High => "high",
    }
}

pub fn bump_band(band: &str) -> &'static str {
    match band {
        "low" => "mid",
        "mid" => "high",
        _ => "high",
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

pub fn bare_id(slug: &str) -> &str {
    slug.trim_start_matches('~')
}

pub fn ids_match(left: &str, right: &str) -> bool {
    left == right || bare_id(left) == bare_id(right)
}

pub fn context_length(models: Option<&OpenRouterModels>, slug: &str) -> u64 {
    lookup(models, slug)
        .and_then(|model| model.context_length)
        .unwrap_or(8192)
}

pub fn max_completion_tokens(models: Option<&OpenRouterModels>, slug: &str) -> Option<u64> {
    lookup(models, slug).and_then(|model| model.max_completion_tokens)
}

pub fn supports_reasoning(models: Option<&OpenRouterModels>, slug: &str) -> bool {
    lookup(models, slug)
        .map(|model| {
            model
                .supported_parameters
                .iter()
                .any(|param| param == "reasoning" || param == "include_reasoning")
        })
        .unwrap_or(true)
}

fn lookup<'a>(
    models: Option<&'a OpenRouterModels>,
    slug: &str,
) -> Option<&'a crate::providers::openrouter::OpenRouterModel> {
    let models = models?;
    models
        .free
        .iter()
        .chain(models.paid.iter())
        .find(|model| ids_match(&model.id, slug))
}

pub struct LargerFit<'a> {
    pub candidates: &'a [&'a str],
    pub models: Option<&'a OpenRouterModels>,
    pub input_tokens: u64,
    pub max_tokens: u64,
    pub current: &'a str,
}

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
