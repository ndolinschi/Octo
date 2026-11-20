use std::path::Path;

use serde::Deserialize;

use super::band::{heuristic, HeuristicInput};
use super::types::Band;

/// Version of the heuristic rule; bump it whenever `band::heuristic` changes, so exported records say which rule
/// produced their band.
pub const HEURISTIC_VERSION: &str = "heuristic-v1";
/// Version of the JEV classifier glue (one Decisions call, the `is_hard` / `is_easy` thresholds of the ladder).
pub const JEV_VERSION: &str = "jev-v1";

/// `[autoroute.delegation]`: which classifier decides the band of a delegated task.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(default)]
pub struct DelegationSettings {
    pub classifier: String,
    pub model_path: String,
}

impl Default for DelegationSettings {
    fn default() -> Self {
        Self {
            classifier: "jev".to_string(),
            model_path: String::new(),
        }
    }
}

impl DelegationSettings {
    pub fn kind(&self) -> Option<DelegationClassifier> {
        DelegationClassifier::parse(&self.classifier, &self.model_path)
    }
}

/// The classifier seam of the delegation decision. `Jev` is one LLM (Decisions) call, `Heuristic` a deterministic
/// rule with no call, `Learned` a trained model that is declared but not built: it always falls back to the heuristic
/// and says why.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DelegationClassifier {
    Jev,
    Heuristic,
    Learned { model_path: String },
}

impl DelegationClassifier {
    pub fn parse(raw: &str, model_path: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "jev" => Some(Self::Jev),
            "heuristic" => Some(Self::Heuristic),
            "learned" => Some(Self::Learned {
                model_path: model_path.trim().to_string(),
            }),
            _ => None,
        }
    }

    pub fn name(&self) -> &'static str {
        match self {
            Self::Jev => "jev",
            Self::Heuristic => "heuristic",
            Self::Learned { .. } => "learned",
        }
    }

    /// Why the learned classifier cannot decide in this build. `None` would mean it can (never, until a model
    /// runtime is added).
    pub fn learned_unavailable(model_path: &str) -> String {
        if model_path.is_empty() {
            "learned model not available: no autoroute.delegation.model_path configured".to_string()
        } else if !Path::new(model_path).is_file() {
            "learned model not available: model file not found".to_string()
        } else {
            "learned model not available: this build has no model runtime".to_string()
        }
    }
}

/// How the band was reached.
#[derive(Clone, Debug, PartialEq)]
pub enum VerdictStatus {
    /// The configured classifier decided.
    Used,
    /// Another one decided; the text is why the configured one did not.
    Fallback(String),
    /// No classifier ran because the budget is reached; the heuristic gave the band.
    Skipped,
}

impl VerdictStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Used => "used",
            Self::Fallback(_) => "fallback",
            Self::Skipped => "skipped",
        }
    }

    pub fn fallback_reason(&self) -> Option<&str> {
        match self {
            Self::Fallback(why) => Some(why),
            _ => None,
        }
    }
}

/// A band and everything the decision record needs to say about how it was reached.
#[derive(Clone, Debug, PartialEq)]
pub struct Verdict {
    pub band: Band,
    pub requested: &'static str,
    pub decided_by: &'static str,
    pub version: &'static str,
    pub status: VerdictStatus,
    /// Per-tier success probabilities (low, mid, high) of a learned model; `None` for every classifier built today.
    pub probabilities: Option<[f64; 3]>,
    pub cost_micros: u64,
    pub cost_source: &'static str,
    pub input_tokens: u64,
    pub output_tokens: u64,
}

impl Verdict {
    /// The heuristic's band, labelled as the configured classifier's fallback (`why`), as a deliberate choice
    /// (`why` is `None` and the heuristic is configured), or as skipped (budget).
    pub fn heuristic(
        input: &HeuristicInput<'_>,
        requested: &'static str,
        status: VerdictStatus,
    ) -> Self {
        Self {
            band: heuristic(input),
            requested,
            decided_by: "heuristic",
            version: HEURISTIC_VERSION,
            status,
            probabilities: None,
            cost_micros: 0,
            cost_source: "estimated",
            input_tokens: 0,
            output_tokens: 0,
        }
    }
}
