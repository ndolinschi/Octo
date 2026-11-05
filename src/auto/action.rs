#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Forward {
    pub body: Vec<u8>,
    pub rerouting: i64,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Compact {
    pub body: Vec<u8>,
    pub model: String,
    pub fallback_model: Option<String>,
}

pub trait ModelAction {
    fn rerouting(&self) -> (i64, Option<&str>);
}

impl ModelAction for Forward {
    fn rerouting(&self) -> (i64, Option<&str>) {
        (self.rerouting, self.reason.as_deref())
    }
}

impl ModelAction for Compact {
    fn rerouting(&self) -> (i64, Option<&str>) {
        (0, None)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Turn {
    Forward(Forward),
    Compact(Compact),
}

impl ModelAction for Turn {
    fn rerouting(&self) -> (i64, Option<&str>) {
        match self {
            Self::Forward(action) => action.rerouting(),
            Self::Compact(action) => action.rerouting(),
        }
    }
}
