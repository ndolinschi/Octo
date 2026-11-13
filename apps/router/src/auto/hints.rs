use axum::http::HeaderMap;

pub const BUDGET_KEY_HEADER: &str = "x-octo-budget-key";
pub const BUDGET_USD_HEADER: &str = "x-octo-budget-usd";
pub const AGENT_ROLE_HEADER: &str = "x-octo-agent-role";
pub const AGENT_DEPTH_HEADER: &str = "x-octo-agent-depth";
pub const TIER_HINT_HEADER: &str = "x-octo-tier-hint";
pub const TIER_POLICY_HEADER: &str = "x-octo-tier-policy";
pub const TASK_HEADER: &str = "x-octo-task";

const BUDGET_KEY_MAX_LEN: usize = 128;
const TASK_MAX_CHARS: usize = 200;

/// `x-octo-tier-hint` carried a value that is none of the accepted ones.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InvalidTierHint {
    reason: TierHintFault,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum TierHintFault {
    Unknown(String),
    Undecodable,
    Conflict,
}

const ACCEPTED_TIERS: &str =
    "accepted values are low, mid, high (or fast, balanced, deep), case-insensitive";

impl InvalidTierHint {
    pub fn message(&self) -> String {
        match &self.reason {
            TierHintFault::Unknown(value) => {
                format!("invalid {TIER_HINT_HEADER} `{value}`: {ACCEPTED_TIERS}")
            }
            TierHintFault::Undecodable => format!(
                "invalid {TIER_HINT_HEADER}: the value is not visible ASCII; {ACCEPTED_TIERS}"
            ),
            TierHintFault::Conflict => format!(
                "conflicting {TIER_HINT_HEADER} headers: send one, or repeat the same tier; {ACCEPTED_TIERS}"
            ),
        }
    }
}

fn parse_tier_hints(headers: &mut HeaderMap) -> Result<Option<&'static str>, InvalidTierHint> {
    let values: Vec<_> = headers.get_all(TIER_HINT_HEADER).iter().cloned().collect();
    headers.remove(TIER_HINT_HEADER);
    let mut found: Option<&'static str> = None;
    for value in values {
        let Ok(raw) = value.to_str() else {
            return Err(InvalidTierHint {
                reason: TierHintFault::Undecodable,
            });
        };
        let raw = raw.trim();
        if raw.is_empty() {
            continue;
        }
        let band = match raw.to_ascii_lowercase().as_str() {
            "low" | "fast" => "low",
            "mid" | "balanced" => "mid",
            "high" | "deep" => "high",
            _ => {
                return Err(InvalidTierHint {
                    reason: TierHintFault::Unknown(
                        raw.chars().filter(|c| !c.is_control()).take(40).collect(),
                    ),
                })
            }
        };
        match found {
            Some(earlier) if earlier != band => {
                return Err(InvalidTierHint {
                    reason: TierHintFault::Conflict,
                })
            }
            _ => found = Some(band),
        }
    }
    Ok(found)
}

impl std::fmt::Display for InvalidTierHint {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message())
    }
}

impl std::error::Error for InvalidTierHint {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum TierPolicy {
    #[default]
    Auto,
    Ceiling,
    Fixed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentRole {
    Orchestrator,
    Sub,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Hints {
    pub budget_key: Option<String>,
    pub budget_micros: Option<u64>,
    pub role: Option<AgentRole>,
    pub depth: Option<u32>,
    pub tier: Option<&'static str>,
    pub policy: TierPolicy,
    pub task: Option<String>,
}

impl Hints {
    pub fn is_sub(&self) -> bool {
        self.role == Some(AgentRole::Sub) || self.depth.is_some_and(|depth| depth > 0)
    }

    pub fn has_tier(&self) -> bool {
        self.tier.is_some()
    }

    /// Reads and removes every hint header. Invalid budget/role/depth/policy/task values are ignored; an invalid
    /// tier hint is an error (the caller answers 400). All hint headers are removed either way.
    pub fn take(headers: &mut HeaderMap) -> Result<Self, InvalidTierHint> {
        let budget_key = text(headers, BUDGET_KEY_HEADER).and_then(|value| {
            if !valid_budget_key(&value) {
                tracing::debug!(header = BUDGET_KEY_HEADER, "ignored invalid hint");
                None
            } else {
                Some(value)
            }
        });
        let budget_micros = text(headers, BUDGET_USD_HEADER).and_then(|value| {
            let parsed = value
                .parse::<f64>()
                .ok()
                .filter(|v| v.is_finite() && *v > 0.0);
            if parsed.is_none() {
                tracing::debug!(header = BUDGET_USD_HEADER, "ignored invalid hint");
            }
            parsed.map(|usd| (usd * 1_000_000.0).round() as u64)
        });
        let role = text(headers, AGENT_ROLE_HEADER).and_then(|value| {
            match value.to_ascii_lowercase().as_str() {
                "orchestrator" => Some(AgentRole::Orchestrator),
                "sub" => Some(AgentRole::Sub),
                _ => {
                    tracing::debug!(header = AGENT_ROLE_HEADER, "ignored invalid hint");
                    None
                }
            }
        });
        let depth = text(headers, AGENT_DEPTH_HEADER).and_then(|value| {
            let parsed = value.parse::<u32>().ok();
            if parsed.is_none() {
                tracing::debug!(header = AGENT_DEPTH_HEADER, "ignored invalid hint");
            }
            parsed
        });
        let tier = parse_tier_hints(headers);
        let policy = text(headers, TIER_POLICY_HEADER)
            .and_then(|value| match value.to_ascii_lowercase().as_str() {
                "auto" => Some(TierPolicy::Auto),
                "ceiling" => Some(TierPolicy::Ceiling),
                "fixed" => Some(TierPolicy::Fixed),
                _ => {
                    tracing::debug!(header = TIER_POLICY_HEADER, "ignored invalid hint");
                    None
                }
            })
            .unwrap_or_default();
        let task = text(headers, TASK_HEADER).and_then(|value| {
            let decoded = percent_decode(&value);
            if decoded.is_none() {
                tracing::debug!(header = TASK_HEADER, "ignored invalid hint");
            }
            decoded
        });
        let tier = tier?;
        Ok(Self {
            budget_micros: budget_key.as_ref().and(budget_micros),
            budget_key,
            role,
            depth,
            tier,
            policy,
            task,
        })
    }
}

pub fn valid_budget_key(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= BUDGET_KEY_MAX_LEN
        && value.chars().all(|c| c.is_ascii_graphic())
}

fn text(headers: &mut HeaderMap, name: &str) -> Option<String> {
    let value = headers.remove(name)?;
    let value = value.to_str().ok()?.trim();
    if value.is_empty() {
        return None;
    }
    Some(value.to_string())
}

fn percent_decode(raw: &str) -> Option<String> {
    let bytes = raw.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'%' => {
                let hex = raw.get(index + 1..index + 3)?;
                out.push(u8::from_str_radix(hex, 16).ok()?);
                index += 3;
            }
            b'+' => {
                out.push(b' ');
                index += 1;
            }
            other => {
                out.push(other);
                index += 1;
            }
        }
    }
    let decoded = String::from_utf8(out).ok()?;
    let cleaned: String = decoded
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .take(TASK_MAX_CHARS)
        .collect();
    let cleaned = cleaned.trim().to_string();
    if cleaned.is_empty() {
        None
    } else {
        Some(cleaned)
    }
}
