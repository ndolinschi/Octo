#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Classified {
    pub complexity: Complexity,
    pub choice_rule: &'static str,
    pub is_hard: Option<bool>,
    pub is_easy: Option<bool>,
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
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Complexity {
    Low,
    Mid,
    High,
}

pub struct ClassifyRequest<'a> {
    pub client: &'a reqwest::Client,
    pub decisions_url: &'a str,
    pub api_key: &'a str,
    pub user_text: &'a str,
    pub tool_names: &'a [String],
    pub current_tools: &'a [String],
}

pub struct ToolNeed<'a> {
    pub all: &'a [String],
    pub current: &'a [String],
    pub enough: bool,
    pub missing: &'a [String],
}
