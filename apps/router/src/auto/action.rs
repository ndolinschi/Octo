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
}

impl ModelAction for Turn {
    fn rerouting(&self) -> (i64, Option<String>) {
        match self {
            Self::Forward(action) => action.rerouting(),
            Self::Compact(action) => action.rerouting(),
        }
    }
}
