use serde_json::{json, Value};

pub fn payload(user_text: &str, tool_names: &[String], current_tools: &[String]) -> Value {
    json!({
        "model": "typesafe/jev-1.13",
        "state": {
            "user_text": user_text,
            "tools": tool_names,
            "current_tools": current_tools,
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
        "instructions": "Read user_text and the tool list and judge this turn on its own. Simple: one obvious step, a greeting, a title, a tiny rewrite, or a single lookup. Medium: a clear goal that needs a few reads or tool calls, or an explanation of code that is already there, without design or a long investigation. Hard: unknown-cause debugging, architecture, tradeoffs, or a change that spans several parts. Answer from that text. A band is not a default.",
        "criteria": {
            "true": "The turn is hard: unknown-cause debugging, architecture, tradeoffs, or a change across several parts.",
            "false": "The turn is simple or medium, as defined in the instructions."
        }
    })
}

fn easy_question() -> Value {
    json!({
        "type": "noul",
        "instructions": "Using the same reading of user_text, is this turn the simple band? Simple is one obvious step. Medium needs a few steps but has a clear goal. Hard is design, a long debug, or a wide change. Answer from the text, not from which band feels safest.",
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
