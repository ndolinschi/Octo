use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Band {
    Easy,
    Medium,
    Hard,
}

impl Band {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Easy => "easy",
            Self::Medium => "medium",
            Self::Hard => "hard",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "easy" => Some(Self::Easy),
            "medium" => Some(Self::Medium),
            "hard" => Some(Self::Hard),
            _ => None,
        }
    }

    pub fn rank(self) -> u8 {
        match self {
            Self::Easy => 0,
            Self::Medium => 1,
            Self::Hard => 2,
        }
    }

    pub fn tier(self) -> ApiTier {
        match self {
            Self::Easy => ApiTier::Fast,
            Self::Medium => ApiTier::Balanced,
            Self::Hard => ApiTier::Deep,
        }
    }

    pub fn from_complexity(complexity: crate::auto::Complexity) -> Self {
        match complexity {
            crate::auto::Complexity::Low => Self::Easy,
            crate::auto::Complexity::Mid => Self::Medium,
            crate::auto::Complexity::High => Self::Hard,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ApiTier {
    Fast,
    Balanced,
    Deep,
}

impl ApiTier {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Fast => "fast",
            Self::Balanced => "balanced",
            Self::Deep => "deep",
        }
    }

    pub fn rank(self) -> u8 {
        match self {
            Self::Fast => 0,
            Self::Balanced => 1,
            Self::Deep => 2,
        }
    }

    pub fn ladder_band(self) -> &'static str {
        match self {
            Self::Fast => "low",
            Self::Balanced => "mid",
            Self::Deep => "high",
        }
    }

    pub fn band(self) -> Band {
        match self {
            Self::Fast => Band::Easy,
            Self::Balanced => Band::Medium,
            Self::Deep => Band::Hard,
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "fast" | "low" => Some(Self::Fast),
            "balanced" | "mid" => Some(Self::Balanced),
            "deep" | "high" => Some(Self::Deep),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Candidate {
    Api {
        id: String,
        tier: ApiTier,
    },
    Agent {
        id: String,
        #[serde(default)]
        label: String,
        flat_rate: bool,
        logged_in: bool,
        #[serde(default)]
        limit_remaining: Option<f64>,
        #[serde(default)]
        strengths: Vec<String>,
    },
}

impl Candidate {
    pub fn id(&self) -> &str {
        match self {
            Self::Api { id, .. } | Self::Agent { id, .. } => id,
        }
    }

    pub fn usable_agent(&self) -> bool {
        matches!(
            self,
            Self::Agent { logged_in: true, limit_remaining, .. }
                if limit_remaining.is_none_or(|left| left > 0.0)
        )
    }

    pub fn usable(&self) -> bool {
        matches!(self, Self::Api { .. }) || self.usable_agent()
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct Task {
    pub title: String,
    #[serde(default)]
    pub brief: String,
    #[serde(default)]
    pub tools: Vec<String>,
    #[serde(default)]
    pub depth: u32,
    /// The tier the delegating (parent) agent runs at, when the caller knows it.
    #[serde(default)]
    pub parent_tier: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RouteRequest {
    pub budget_key: String,
    pub task: Task,
    pub candidates: Vec<Candidate>,
    /// The caller's session the delegation belongs to (recorded only).
    #[serde(default)]
    pub session_id: Option<String>,
    /// 1 for a first delegation, 2 for the retry of an escalation.
    #[serde(default)]
    pub attempt: Option<u32>,
    /// The request id of the delegation this one retries.
    #[serde(default)]
    pub escalated_from: Option<String>,
    /// Candidate ids that must not be chosen (the one that failed).
    #[serde(default)]
    pub exclude: Vec<String>,
    /// The lowest API tier (and band) the choice may have.
    #[serde(default)]
    pub min_tier: Option<ApiTier>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Alternative {
    pub id: String,
    pub estimated_cost_usd: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct RouteResponse {
    pub choice: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    pub band: Band,
    pub reason: String,
    pub estimated_cost_usd: Option<f64>,
    pub alternatives: Vec<Alternative>,
    pub request_id: String,
    /// The classifier that decided the band (`jev`, `heuristic`; `learned` once a model runs).
    pub classifier: &'static str,
    pub attempt: u32,
}
