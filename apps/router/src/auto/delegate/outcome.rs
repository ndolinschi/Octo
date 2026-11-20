use serde::{Deserialize, Serialize};

use crate::history::SessionOutcome;

/// What an outcome report is about.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OutcomeEvent {
    /// The delegated sub-agent ended (any status).
    Finished,
    /// The orchestrator delegated a similar task again under the same parent after this one ended.
    Redelegated,
    /// The harness retried the same brief on a stronger candidate after this one failed.
    Escalated,
    /// The person rewound the conversation to before the turn that used this result.
    Rewound,
    /// The person reverted a file change this sub-agent made.
    Reverted,
}

impl OutcomeEvent {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Finished => "finished",
            Self::Redelegated => "redelegated",
            Self::Escalated => "escalated",
            Self::Rewound => "rewound",
            Self::Reverted => "reverted",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FinishStatus {
    Completed,
    Failed,
    Stopped,
    TimedOut,
    AgentError,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentSignal {
    /// A final report without the "could not do it" marker.
    Done,
    /// The sub-agent said it could not do the task.
    CouldNot,
    /// No final report.
    None,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct OutcomeUsage {
    #[serde(default)]
    pub turns: Option<u64>,
    #[serde(default)]
    pub tool_calls: Option<u64>,
    #[serde(default)]
    pub failed_tool_calls: Option<u64>,
    #[serde(default)]
    pub input_tokens: Option<u64>,
    #[serde(default)]
    pub output_tokens: Option<u64>,
    #[serde(default)]
    pub cache_read_tokens: Option<u64>,
    #[serde(default)]
    pub cache_write_tokens: Option<u64>,
    #[serde(default)]
    pub cost_usd: Option<f64>,
    #[serde(default)]
    pub cost_estimated: Option<bool>,
    #[serde(default)]
    pub flat_rate: Option<bool>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct TestsReport {
    #[serde(default)]
    pub passed: Option<i64>,
    #[serde(default)]
    pub failed: Option<i64>,
    /// `pass`, `fail` or `unknown`, as in `session_outcomes.last_status`.
    pub status: String,
}

/// Body of `POST /autoroute/v1/route/{request_id}/outcome`. Unknown fields are ignored.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OutcomeReport {
    /// The sender's id of this report: the same id twice is stored once (retries are safe).
    pub report_id: String,
    pub event: OutcomeEvent,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<FinishStatus>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_signal: Option<AgentSignal>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<OutcomeUsage>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tests: Option<TestsReport>,
    /// For `redelegated` / `escalated`: the request id of the delegation that followed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub by: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub after_failure: Option<bool>,
    /// For `escalated`: why (`agent_error`, `timed_out`, `failed`, `could_not`, `tests_failed`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// The sender's clock (RFC 3339), informational; the router's receive time is what orders reports.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub at: Option<String>,
}

const MAX_ID: usize = 128;
const MAX_CODE: usize = 64;

impl OutcomeReport {
    pub fn validate(&self) -> Result<(), String> {
        let id_ok = |id: &str| {
            !id.trim().is_empty() && id.len() <= MAX_ID && id.chars().all(|c| c.is_ascii_graphic())
        };
        if !id_ok(&self.report_id) {
            return Err("report_id must be 1 to 128 printable ASCII characters".into());
        }
        if self.event == OutcomeEvent::Finished && self.status.is_none() {
            return Err("a finished report needs a status".into());
        }
        if let Some(by) = &self.by {
            if !id_ok(by) {
                return Err("by must be a request id".into());
            }
        }
        for (name, code) in [
            ("error_kind", &self.error_kind),
            ("reason", &self.reason),
            ("session_id", &self.session_id),
        ] {
            if let Some(code) = code {
                let limit = if name == "session_id" { 256 } else { MAX_CODE };
                if code.len() > limit || code.chars().any(char::is_control) {
                    return Err(format!("{name} must be at most {limit} characters"));
                }
            }
        }
        if let Some(tests) = &self.tests {
            if !matches!(tests.status.as_str(), "pass" | "fail" | "unknown") {
                return Err("tests.status must be pass, fail or unknown".into());
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Solved {
    Yes,
    No,
    Unknown,
}

impl Solved {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Yes => "yes",
            Self::No => "no",
            Self::Unknown => "unknown",
        }
    }
}

/// The derived label of a delegation: `solved`, the rule that decided it, how much to trust it, and a sentence.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Label {
    pub solved: Solved,
    pub rule: &'static str,
    pub confidence: &'static str,
    pub note: &'static str,
}

const fn label(
    solved: Solved,
    rule: &'static str,
    confidence: &'static str,
    note: &'static str,
) -> Label {
    Label {
        solved,
        rule,
        confidence,
        note,
    }
}

/// The test result that counts for the label: the harness's own report on the latest `finished` event, else the
/// router's parse of the sub-agent's tool output (`session_outcomes` of its session).
fn last_tests(finished: &OutcomeReport, session: Option<&SessionOutcome>) -> Option<String> {
    if let Some(tests) = &finished.tests {
        if tests.status != "unknown" {
            return Some(tests.status.clone());
        }
    }
    session
        .map(|s| s.last_status.clone())
        .filter(|status| status != "unknown")
}

/// The one place the `solved` label is computed. Rules, first match wins (docs/history.md, "Delegation records"):
///
/// 1. `no_outcome`: no `finished` report yet: unknown.
/// 2. `stopped`: the person stopped it: unknown (says nothing about the candidate).
/// 3. `did_not_finish`: failed, timed out or agent error: no (high).
/// 4. `could_not`: the sub-agent said it could not do it: no (high).
/// 5. `escalated`: the harness retried it on a stronger candidate: no (high; follows 3/4 or a failing test).
/// 6. `redelegated`: the orchestrator delegated a similar task again: no (medium after a failure, low after success).
/// 7. `undone`: the person rewound the turn or reverted its files: no (low).
/// 8. `tests_failed`: the last test run in the sub-agent failed: no (medium).
/// 9. `empty_report`: completed without a final report: unknown.
/// 10. `tests_passed`: completed and its last test run passed: yes (high).
/// 11. `completed`: completed, no negative signal, no test run: yes (low).
///
/// `outcomes` are the reports in arrival order; `session` is the test summary of the sub-agent's router session.
pub fn derive(outcomes: &[OutcomeReport], session: Option<&SessionOutcome>) -> Label {
    let Some(finished) = outcomes
        .iter()
        .rev()
        .find(|report| report.event == OutcomeEvent::Finished)
    else {
        return label(
            Solved::Unknown,
            "no_outcome",
            "none",
            "No finished report yet.",
        );
    };
    let any = |event: OutcomeEvent| outcomes.iter().any(|report| report.event == event);
    match finished.status {
        Some(FinishStatus::Stopped) => {
            return label(
                Solved::Unknown,
                "stopped",
                "none",
                "Stopped by the person: says nothing about the candidate.",
            )
        }
        Some(FinishStatus::Failed | FinishStatus::TimedOut | FinishStatus::AgentError) => {
            return label(
                Solved::No,
                "did_not_finish",
                "high",
                "The sub-agent failed, timed out or hit an agent error.",
            )
        }
        _ => {}
    }
    if finished.agent_signal == Some(AgentSignal::CouldNot) {
        return label(
            Solved::No,
            "could_not",
            "high",
            "The sub-agent reported that it could not do the task.",
        );
    }
    if any(OutcomeEvent::Escalated) {
        return label(
            Solved::No,
            "escalated",
            "high",
            "The harness retried the task on a stronger candidate.",
        );
    }
    if let Some(redo) = outcomes
        .iter()
        .find(|report| report.event == OutcomeEvent::Redelegated)
    {
        return if redo.after_failure == Some(true) {
            label(
                Solved::No,
                "redelegated",
                "medium",
                "The orchestrator delegated a similar task again after this one failed.",
            )
        } else {
            label(
                Solved::No,
                "redelegated",
                "low",
                "The orchestrator delegated a similar task again although this one completed.",
            )
        };
    }
    if any(OutcomeEvent::Rewound) || any(OutcomeEvent::Reverted) {
        return label(
            Solved::No,
            "undone",
            "low",
            "The person rewound the turn or reverted files this sub-agent changed.",
        );
    }
    let tests = last_tests(finished, session);
    if tests.as_deref() == Some("fail") {
        return label(
            Solved::No,
            "tests_failed",
            "medium",
            "The last test run in the sub-agent failed.",
        );
    }
    if finished.agent_signal == Some(AgentSignal::None) {
        return label(
            Solved::Unknown,
            "empty_report",
            "none",
            "Completed without a final report.",
        );
    }
    if tests.as_deref() == Some("pass") {
        return label(
            Solved::Yes,
            "tests_passed",
            "high",
            "Completed and its last test run passed.",
        );
    }
    label(
        Solved::Yes,
        "completed",
        "low",
        "Completed with no negative signal and no test run.",
    )
}

/// Parses stored report bodies (arrival order), skipping any that no longer parse.
pub fn parse_reports(bodies: &[serde_json::Value]) -> Vec<OutcomeReport> {
    bodies
        .iter()
        .filter_map(|body| serde_json::from_value(body.clone()).ok())
        .collect()
}

/// The router session whose test summary counts: the one named by the latest `finished` report.
pub fn finished_session(reports: &[OutcomeReport]) -> Option<&str> {
    reports
        .iter()
        .rev()
        .find(|report| report.event == OutcomeEvent::Finished)
        .and_then(|report| report.session_id.as_deref())
        .filter(|id| !id.is_empty())
}
