use super::routing::RouteMeta;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Forward {
    pub body: Vec<u8>,
    pub meta: RouteMeta,
    pub trimmed_from_tokens: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Compact {
    pub body: Vec<u8>,
    pub model: String,
    pub fallback_model: Option<String>,
    pub decided_tier: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Reject {
    pub budget_micros: u64,
    pub spent_micros: u64,
    pub budget_key: Option<String>,
}

impl Reject {
    pub fn message(&self) -> String {
        let scope = match &self.budget_key {
            Some(key) => format!("budget key `{key}`"),
            None => "session".to_string(),
        };
        format!(
            "autoroute {scope} budget exceeded: spent ${} of ${} (autoroute.session_budget_usd, session_budget_action = reject)",
            usd(self.spent_micros),
            usd(self.budget_micros)
        )
    }
}

fn usd(micros: u64) -> String {
    format!("{}.{:06}", micros / 1_000_000, micros % 1_000_000)
}

pub trait ModelAction {
    fn rerouting(&self) -> (i64, Option<String>);
}

impl ModelAction for Forward {
    fn rerouting(&self) -> (i64, Option<String>) {
        (self.meta.rerouting(), self.meta.legacy_reason())
    }
}

impl ModelAction for Compact {
    fn rerouting(&self) -> (i64, Option<String>) {
        (0, None)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Turn {
    Forward(Forward),
    Compact(Compact),
    Reject(Reject),
}

impl ModelAction for Turn {
    fn rerouting(&self) -> (i64, Option<String>) {
        match self {
            Self::Forward(action) => action.rerouting(),
            Self::Compact(action) => action.rerouting(),
            Self::Reject(_) => (0, None),
        }
    }
}
