use serde_json::{json, Value};

use super::context::ContextFacts;

pub struct PayloadPlan<'a> {
    pub user_text: &'a str,
    pub tool_names: &'a [String],
    pub current_tools: &'a [String],
    pub facts: &'a ContextFacts,
    pub current_tier: &'a str,
}

pub fn payload(plan: PayloadPlan<'_>) -> Value {
    json!({
        "model": "typesafe/jev-1.13",
        "state": {
            "user_text": plan.user_text,
            "tools": plan.tool_names,
            "current_tools": plan.current_tools,
            "recent_errors": plan.facts.recent_errors,
            "turn_index": plan.facts.turn_index,
            "current_tier": plan.current_tier,
            "files_touched": plan.facts.files_touched,
            "mentions_tests": plan.facts.mentions_tests,
            "mentions_stack_trace": plan.facts.mentions_stack_trace,
            "mentions_multiple_files": plan.facts.mentions_multiple_files,
        },
        "questions": {
            "is_hard": hard_question(),
            "is_easy": easy_question(),
            "tools_enough": tools_question(),
        }
    })
}

fn hard_question() -> Value {
    json!({
        "type": "noul",
        "instructions": "Read user_text, recent_errors, files_touched, and the tool list and judge this turn on its own. Simple: one obvious step, a greeting, a title, a tiny rewrite, or a single lookup. Medium: a clear goal that needs a few reads or tool calls, or an explanation of code that is already there, without design or a long investigation. Hard: unknown-cause debugging, architecture, tradeoffs, or a change that spans several parts. Answer from that text. A band is not a default.",
        "criteria": {
            "true": "The turn is hard: unknown-cause debugging, architecture, tradeoffs, or a change across several parts.",
            "false": "The turn is simple or medium, as defined in the instructions."
        }
    })
}

fn easy_question() -> Value {
    json!({
        "type": "noul",
        "instructions": "Using the same reading of user_text and state, is this turn the simple band? Simple is one obvious step. Medium needs a few steps but has a clear goal. Hard is design, a long debug, or a wide change. Answer from the text, not from which band feels safest.",
        "criteria": {
            "true": "The turn is simple: a greeting, a title, a tiny rewrite, or one obvious lookup.",
            "false": "The turn is medium or hard, as defined in the instructions."
        }
    })
}

fn tools_question() -> Value {
    json!({
        "type": "noul",
        "instructions": "Can current_tools finish this user_text? If false, the value may be a comma-separated list of missing tool names from tools.",
        "criteria": {
            "true": "Every needed tool is already in current_tools, or no tool is needed.",
            "false": "Name each tool in tools that is missing from current_tools, comma-separated."
        }
    })
}
