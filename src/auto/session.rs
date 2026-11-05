use std::collections::HashMap;
use std::time::{Duration, Instant};

#[derive(Debug, Clone)]
pub struct SessionChoice {
    pub model: String,
    pub tools: Vec<String>,
    pub prev_input_tokens_est: u64,
    pub awaiting_compact: bool,
    pub seen: Instant,
    pub sticky_band: String,
    pub escalate_remaining: u32,
    pub escalate_band: Option<String>,
    pub last_stall: Option<String>,
    pub pending_down_band: Option<String>,
    pub down_count: u32,
}

impl SessionChoice {
    pub fn fresh(model: String, tools: Vec<String>, sticky_band: String) -> Self {
        Self {
            model,
            tools,
            prev_input_tokens_est: 0,
            awaiting_compact: false,
            seen: Instant::now(),
            sticky_band,
            escalate_remaining: 0,
            escalate_band: None,
            last_stall: None,
            pending_down_band: None,
            down_count: 0,
        }
    }
}

#[derive(Debug, Default)]
pub struct Sessions {
    rows: HashMap<String, SessionChoice>,
    ttl: Duration,
}

impl Sessions {
    pub fn new(ttl: Duration) -> Self {
        Self {
            rows: HashMap::new(),
            ttl,
        }
    }

    pub fn get(&mut self, id: &str) -> Option<SessionChoice> {
        self.expire();
        let row = self.rows.get_mut(id)?;
        row.seen = Instant::now();
        Some(row.clone())
    }

    pub fn insert(&mut self, id: String, choice: SessionChoice) {
        self.expire();
        self.rows.insert(id, choice);
    }

    fn expire(&mut self) {
        let ttl = self.ttl;
        self.rows.retain(|_, row| row.seen.elapsed() < ttl);
    }
}
