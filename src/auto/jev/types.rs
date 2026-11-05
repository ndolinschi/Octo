use super::context::ContextFacts;

#[derive(Debug, Clone, PartialEq)]
pub struct Classified {
    pub complexity: Complexity,
    pub choice_rule: &'static str,
    pub is_hard: Option<bool>,
    pub is_easy: Option<bool>,
    pub is_hard_score: Option<f64>,
    pub is_easy_score: Option<f64>,
    pub tools_enough_raw: Option<String>,
    pub tools: Vec<String>,
    pub tools_enough: bool,
    pub missing_tools: Vec<String>,
}

pub struct Asked {
    pub request_body: String,
    pub response_body: String,
    pub status: u16,
    pub latency_ms: u128,
    pub parsed: Option<Classified>,
    pub choice_rule: &'static str,
    pub cost: Option<crate::history::CostMicros>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Complexity {
    Low,
    Mid,
    High,
}

#[derive(Debug, Clone, Copy)]
pub struct Thresholds {
    pub hard: f64,
    pub easy: f64,
}

impl Default for Thresholds {
    fn default() -> Self {
        Self {
            hard: 0.5,
            easy: 0.5,
        }
    }
}

pub struct ClassifyRequest<'a> {
    pub client: &'a reqwest::Client,
    pub decisions_url: &'a str,
    pub api_key: &'a str,
    pub user_text: &'a str,
    pub tool_names: &'a [String],
    pub current_tools: &'a [String],
    pub facts: &'a ContextFacts,
    pub current_tier: &'a str,
    pub thresholds: Thresholds,
}

pub struct ToolNeed<'a> {
    pub all: &'a [String],
    pub current: &'a [String],
    pub enough: bool,
    pub missing: &'a [String],
}
