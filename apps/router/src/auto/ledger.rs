use std::collections::HashMap;
use std::time::{Duration, Instant};

#[derive(Debug, Default)]
pub struct BudgetLedger {
    bindings: HashMap<String, (String, Instant)>,
    spend: HashMap<String, (u64, Instant)>,
    restored: HashMap<String, (u64, Instant)>,
    limits: HashMap<String, (u64, Instant)>,
    ttl: Duration,
}

impl BudgetLedger {
    pub fn new(ttl: Duration) -> Self {
        Self {
            bindings: HashMap::new(),
            spend: HashMap::new(),
            restored: HashMap::new(),
            limits: HashMap::new(),
            ttl,
        }
    }

    pub fn bind(&mut self, session_key: &str, budget_key: &str) {
        self.expire();
        self.bindings.insert(
            session_key.to_string(),
            (budget_key.to_string(), Instant::now()),
        );
        self.spend
            .entry(budget_key.to_string())
            .or_insert((0, Instant::now()))
            .1 = Instant::now();
    }

    pub fn touch(&mut self, budget_key: &str) {
        self.expire();
        self.spend
            .entry(budget_key.to_string())
            .or_insert((0, Instant::now()))
            .1 = Instant::now();
    }

    pub fn set_limit(&mut self, budget_key: &str, micros: u64) {
        self.expire();
        self.limits
            .insert(budget_key.to_string(), (micros, Instant::now()));
    }

    pub fn limit(&mut self, budget_key: &str) -> Option<u64> {
        self.expire();
        self.limits.get(budget_key).map(|(micros, _)| *micros)
    }

    pub fn key_for(&mut self, session_key: &str) -> Option<String> {
        self.expire();
        self.bindings
            .get(session_key)
            .map(|(budget_key, _)| budget_key.clone())
    }

    pub fn spent(&mut self, budget_key: &str) -> u64 {
        self.expire();
        self.spend
            .get(budget_key)
            .map(|(micros, _)| *micros)
            .unwrap_or(0)
    }

    pub fn add(&mut self, budget_key: &str, micros: u64) {
        self.expire();
        let row = self
            .spend
            .entry(budget_key.to_string())
            .or_insert((0, Instant::now()));
        row.0 = row.0.saturating_add(micros);
        row.1 = Instant::now();
    }

    pub fn has_spend(&mut self, budget_key: &str) -> bool {
        self.expire();
        self.spend.contains_key(budget_key)
    }

    pub fn seed(&mut self, budget_key: &str, micros: u64) {
        self.expire();
        self.spend
            .entry(budget_key.to_string())
            .or_insert((micros, Instant::now()))
            .1 = Instant::now();
    }

    pub fn restore(&mut self, session_key: &str, micros: u64) {
        self.expire();
        self.restored
            .entry(session_key.to_string())
            .or_insert((micros, Instant::now()));
    }

    pub fn restored(&mut self, session_key: &str) -> Option<u64> {
        self.expire();
        self.restored.get(session_key).map(|(micros, _)| *micros)
    }

    fn expire(&mut self) {
        let ttl = self.ttl;
        self.bindings.retain(|_, (_, seen)| seen.elapsed() < ttl);
        self.spend.retain(|_, (_, seen)| seen.elapsed() < ttl);
        self.restored.retain(|_, (_, seen)| seen.elapsed() < ttl);
        self.limits.retain(|_, (_, seen)| seen.elapsed() < ttl);
    }
}
