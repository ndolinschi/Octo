pub fn normalize_trigger(reason: Option<&str>) -> String {
    let Some(reason) = reason else {
        return "none".to_string();
    };
    if let Some(kind) = reason.strip_prefix("stall_escalate:") {
        return format!("stall:{kind}");
    }
    match reason {
        "classify"
        | "reclassify"
        | "upgrade"
        | "retry"
        | "hysteresis_hold"
        | "budget_cap"
        | "housekeeping"
        | "housekeeping_trimmed"
        | "permission_check" => reason.to_string(),
        "tool_update" => "reclassify".to_string(),
        "upstream_retry" => "retry".to_string(),
        "stall_release" => "none".to_string(),
        _ => "none".to_string(),
    }
}

pub fn rerouting_from_tiers(tier_before: &str, tier_after: &str) -> i64 {
    i64::from(tier_before != tier_after)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RouteMeta {
    pub tier_before: String,
    pub tier_after: String,
    pub trigger: String,
    pub stripped: Option<String>,
}

impl RouteMeta {
    pub fn housekeeping(tier_before: &str) -> Self {
        Self {
            tier_before: tier_before.to_string(),
            tier_after: "low".to_string(),
            trigger: "housekeeping".to_string(),
            stripped: None,
        }
    }

    pub fn from_plan(tier_before: String, tier_after: String, reason: Option<&str>) -> Self {
        Self {
            tier_before,
            tier_after,
            trigger: normalize_trigger(reason),
            stripped: None,
        }
    }

    pub fn with_stripped(mut self, stripped: &[String]) -> Self {
        if stripped.is_empty() {
            self.stripped = None;
        } else {
            self.stripped = Some(stripped.join(","));
        }
        self
    }

    pub fn rerouting(&self) -> i64 {
        rerouting_from_tiers(&self.tier_before, &self.tier_after)
    }

    pub fn legacy_reason(&self) -> Option<String> {
        let stripped = self
            .stripped
            .as_ref()
            .map(|keys| format!("stripped:{keys}"));
        match (self.trigger.as_str(), stripped) {
            ("none", None) => None,
            ("none", Some(label)) => Some(label),
            (trigger, None) => Some(trigger.to_string()),
            (trigger, Some(label)) => Some(format!("{trigger};{label}")),
        }
    }
}
