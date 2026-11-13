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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
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
}

#[derive(Debug, Clone, Deserialize)]
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
}

#[derive(Debug, Clone, Deserialize)]
pub struct RouteRequest {
    pub budget_key: String,
    pub task: Task,
    pub candidates: Vec<Candidate>,
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
}
