use crate::auto::{asks_file_or_repo_inspection, ContextFacts};

use super::types::{Band, Candidate};

const EASY_MAX_CHARS: usize = 280;
const LONG_BRIEF_CHARS: usize = 1500;

pub fn fallback(facts: &ContextFacts, text: &str, candidates: &[Candidate]) -> Band {
    if let Some(band) = only_tier(candidates) {
        return band;
    }
    let chars = text.chars().count();
    let signals = [
        facts.mentions_multiple_files,
        facts.mentions_tests,
        chars > LONG_BRIEF_CHARS,
    ]
    .into_iter()
    .filter(|signal| *signal)
    .count();
    if facts.mentions_stack_trace || signals >= 2 {
        Band::Hard
    } else if signals == 0 && chars <= EASY_MAX_CHARS && !asks_file_or_repo_inspection(text) {
        Band::Easy
    } else {
        Band::Medium
    }
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
