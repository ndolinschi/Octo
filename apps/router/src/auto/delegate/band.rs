use crate::auto::{asks_file_or_repo_inspection, ContextFacts};

use super::types::{Band, Candidate};

const EASY_MAX_CHARS: usize = 280;
const LONG_BRIEF_CHARS: usize = 1500;
const NESTED_DEPTH: u32 = 2;

/// Phrases that mark work which is usually hard to get right; one of them counts as one signal.
pub const HARD_KEYWORDS: &[&str] = &[
    "race condition",
    "deadlock",
    "concurrency",
    "architecture",
    "security",
    "vulnerab",
    "memory leak",
    "performance",
    "migration",
];

/// Tool-name fragments that can change files or run commands; a tool list without any of them is read-only work.
pub const WRITE_TOOL_FRAGMENTS: &[&str] = &["write", "edit", "bash", "shell", "exec", "patch"];

/// What the heuristic reads besides the text.
pub struct HeuristicInput<'a> {
    pub facts: &'a ContextFacts,
    pub text: &'a str,
    pub tools: &'a [String],
    pub depth: u32,
    pub candidates: &'a [Candidate],
}

/// The deterministic band rule (classifier `heuristic`, and the fallback of every other classifier).
pub fn heuristic(input: &HeuristicInput<'_>) -> Band {
    if let Some(band) = only_tier(input.candidates) {
        return band;
    }
    let text = input.text;
    let facts = input.facts;
    let chars = text.chars().count();
    let signals = [
        facts.mentions_multiple_files,
        facts.mentions_tests,
        chars > LONG_BRIEF_CHARS,
        has_hard_keyword(text),
    ]
    .into_iter()
    .filter(|signal| *signal)
    .count();
    if facts.mentions_stack_trace {
        return Band::Hard;
    }
    let band = if signals >= 2 {
        Band::Hard
    } else if signals == 0 && chars <= EASY_MAX_CHARS && !asks_file_or_repo_inspection(text) {
        Band::Easy
    } else {
        Band::Medium
    };
    let capped = read_only(input.tools) || input.depth >= NESTED_DEPTH;
    if capped && band == Band::Hard {
        Band::Medium
    } else {
        band
    }
}

pub fn has_hard_keyword(text: &str) -> bool {
    let lower = text.to_lowercase();
    HARD_KEYWORDS.iter().any(|word| lower.contains(word))
}

/// A non-empty tool list where no tool can change files or run commands.
pub fn read_only(tools: &[String]) -> bool {
    !tools.is_empty()
        && !tools.iter().any(|tool| {
            let lower = tool.to_lowercase();
            WRITE_TOOL_FRAGMENTS
                .iter()
                .any(|fragment| lower.contains(fragment))
        })
}

fn only_tier(candidates: &[Candidate]) -> Option<Band> {
    let mut found = None;
    for candidate in candidates {
        match candidate {
            Candidate::Agent { .. } if candidate.usable_agent() => return None,
            Candidate::Agent { .. } => {}
            Candidate::Api { tier, .. } => match found {
                None => found = Some(*tier),
                Some(previous) if previous == *tier => {}
                Some(_) => return None,
            },
        }
    }
    found.map(|tier| tier.band())
}
