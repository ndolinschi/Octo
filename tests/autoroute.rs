use serde_json::json;

use octo::auto::context_length;
use octo::auto::{
    choice, choice_from_scores, classified, compaction_body, context_estimate, dropped,
    filter_tools, inspect, is_housekeeping, larger_fit, needed_tools, needs_compact,
    output_reserve, payload, session_id, session_key, with_model, Complexity, LargerFit,
    PayloadPlan, Thresholds, Tiers,
};
use octo::providers::openrouter::{OpenRouterModel, OpenRouterModels};

#[test]
fn session_id_comes_from_metadata_user_id() {
    let body = json!({
        "metadata": {
            "user_id": "{\"session_id\":\"abc\",\"device_id\":\"d\"}"
        }
    });
    assert_eq!(session_id(&body).as_deref(), Some("abc"));
    assert_eq!(session_key(&body).as_deref(), Some("abc"));
    let sub = json!({
        "metadata": {"user_id": "{\"session_id\":\"abc\"}"},
        "system": "x-anthropic-billing-header: cc_version=1; cc_is_subagent=true;"
    });
    assert_eq!(session_key(&sub).as_deref(), Some("abc#subagent"));
    let quoted = json!({
        "metadata": {"user_id": "{\"session_id\":\"abc\"}"},
        "system": "skill text mentions cc_is_subagent=true outside the billing header"
    });
    assert_eq!(session_key(&quoted).as_deref(), Some("abc"));
    assert!(is_housekeeping(
        "Describe your most recent action in 3-5 words"
    ));
    assert!(!is_housekeeping("what is about this branch"));
}

#[test]
fn fill_and_drop_follow_the_window() {
    let estimate = context_estimate(4000, 1500, 4096);
    assert_eq!(estimate.input_tokens_est, 1000);
    assert!(estimate.usable < 1024);
    assert!(needs_compact(estimate));
    let roomy = context_estimate(400, 100_000, 4096);
    assert!(!needs_compact(roomy));
    let reserve = output_reserve(8192, 32_000);
    assert!(reserve <= 4096);
    let held = context_estimate(400, 8192, 32_000);
    assert!(!needs_compact(held));
    assert!(dropped(1000, 400));
    assert!(!dropped(1000, 600));
}

#[test]
fn filter_keeps_named_tools_and_pick_respects_preference() {
    let mut body = json!({
        "tools": [{"name": "Bash"}, {"name": "Read"}]
    });
    filter_tools(&mut body, &["Read".to_string()]);
    assert_eq!(body["tools"].as_array().unwrap().len(), 1);
    let tiers = Tiers::new("low-model".into(), "mid-model".into(), "high-model".into());
    assert_eq!(tiers.pick(Complexity::Low, Some("custom")), "low-model");
    assert_eq!(
        tiers.pick(Complexity::Mid, Some("anthropic/claude-sonnet-4.5")),
        "mid-model"
    );
    assert_eq!(
        tiers.pick(Complexity::High, Some("low-model")),
        "high-model"
    );
    assert_eq!(
        tiers.pick(Complexity::High, Some("custom/high")),
        "custom/high"
    );
    let mut chat = json!({"tools": [{"type": "function", "function": {"name": "Bash"}}]});
    filter_tools(&mut chat, &["Bash".to_string()]);
    assert_eq!(chat["tools"].as_array().unwrap().len(), 1);
}

#[test]
fn first_turn_forwards_all_tools_when_jev_says_missing() {
    let all = vec!["Bash".into(), "Read".into(), "Edit".into()];
    let keep = needed_tools(octo::auto::ToolNeed {
        all: &all,
        current: &[],
        enough: false,
        missing: &["Bash".into()],
    });
    assert_eq!(keep, all);
    let body = json!({
        "model": "client-model",
        "tools": [
            {"name": "Bash"},
            {"name": "Read"},
            {"name": "Edit"}
        ]
    });
    let outgoing = with_model(&body, "mid-model");
    assert_eq!(outgoing["model"], "mid-model");
    assert_eq!(
        outgoing["tools"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|tool| tool["name"].as_str())
            .collect::<Vec<_>>(),
        vec!["Bash", "Read", "Edit"]
    );
}

#[test]
fn later_turn_forwards_all_tools() {
    let all = vec!["Bash".into(), "Read".into(), "Edit".into()];
    let keep = needed_tools(octo::auto::ToolNeed {
        all: &all,
        current: &["Read".into()],
        enough: true,
        missing: &[],
    });
    assert_eq!(keep, all);
    let keep_missing = needed_tools(octo::auto::ToolNeed {
        all: &all,
        current: &["Read".into()],
        enough: false,
        missing: &["Bash".into()],
    });
    assert_eq!(keep_missing, all);
    let body = json!({
        "model": "client-model",
        "tools": [
            {"name": "Bash"},
            {"name": "Read"},
            {"name": "Edit"}
        ]
    });
    let outgoing = with_model(&body, "high-model");
    assert_eq!(outgoing["model"], "high-model");
    assert_eq!(outgoing["tools"].as_array().unwrap().len(), 3);
}

fn paid(id: &str, window: u64) -> OpenRouterModel {
    OpenRouterModel {
        id: id.to_string(),
        name: id.to_string(),
        is_free: false,
        context_length: Some(window),
    }
}

#[test]
fn tilde_high_slug_reads_catalog_window_and_does_not_upgrade_to_low() {
    let models = OpenRouterModels {
        free: Vec::new(),
        paid: vec![
            paid("google/gemma", 128_000),
            paid("deepseek/flash", 64_000),
            paid("anthropic/claude-haiku-latest", 200_000),
        ],
    };
    assert_eq!(
        context_length(Some(&models), "~anthropic/claude-haiku-latest"),
        200_000
    );
    let candidates = [
        "google/gemma",
        "deepseek/flash",
        "~anthropic/claude-haiku-latest",
    ];
    assert_eq!(
        larger_fit(LargerFit {
            candidates: &candidates,
            models: Some(&models),
            input_tokens: 50_000,
            max_tokens: 4096,
            current: "~anthropic/claude-haiku-latest",
        }),
        None
    );
}

#[test]
fn high_pick_ignores_preferred_when_it_matches_low_or_mid_with_tilde() {
    let tiers = Tiers::new(
        "google/gemma".into(),
        "deepseek/flash".into(),
        "~anthropic/claude-haiku-latest".into(),
    );
    assert_eq!(
        tiers.pick(Complexity::High, Some("~google/gemma")),
        "~anthropic/claude-haiku-latest"
    );
    assert_eq!(
        tiers.pick(Complexity::High, Some("custom/high")),
        "custom/high"
    );
}

#[test]
fn larger_fit_chooses_smallest_window_that_still_fits() {
    let models = OpenRouterModels {
        free: Vec::new(),
        paid: vec![
            paid("low-model", 32_000),
            paid("mid-model", 64_000),
            paid("high-model", 200_000),
        ],
    };
    let candidates = ["low-model", "mid-model", "high-model"];
    assert_eq!(
        larger_fit(LargerFit {
            candidates: &candidates,
            models: Some(&models),
            input_tokens: 40_000,
            max_tokens: 4096,
            current: "low-model",
        })
        .as_deref(),
        Some("mid-model")
    );
}

#[test]
fn jev_payload_includes_enriched_state() {
    let body = json!({
        "messages": [
            {
                "role": "assistant",
                "content": [{"type": "tool_use", "name": "Edit", "input": {"file_path": "src/a.rs"}}]
            },
            {
                "role": "user",
                "content": [
                    {"type": "tool_result", "is_error": true, "content": "error: boom"},
                    {"type": "text", "text": "fix the traceback in src/a.rs and src/b.rs and add a unit test"}
                ]
            }
        ]
    });
    let user_text = "fix the traceback in src/a.rs and src/b.rs and add a unit test";
    let facts = inspect(&body, user_text);
    assert_eq!(facts.turn_index, 1);
    assert_eq!(facts.recent_errors, vec!["error: boom".to_string()]);
    assert!(facts.files_touched.iter().any(|path| path == "src/a.rs"));
    assert!(facts.mentions_stack_trace);
    assert!(facts.mentions_multiple_files);
    assert!(facts.mentions_tests);
    let prose = inspect(
        &json!({"messages": []}),
        "ship the latest contest build v1.2.3",
    );
    assert!(!prose.mentions_tests);
    assert!(!prose.mentions_multiple_files);
    let tools = vec!["Bash".into(), "Edit".into()];
    let value = payload(PayloadPlan {
        user_text,
        tool_names: &tools,
        current_tools: &tools,
        facts: &facts,
        current_tier: "low",
    });
    let state = &value["state"];
    assert_eq!(state["current_tier"], "low");
    assert_eq!(state["turn_index"], 1);
    assert_eq!(state["recent_errors"][0], "error: boom");
    assert!(state["mentions_stack_trace"].as_bool().unwrap());
    assert!(state["mentions_tests"].as_bool().unwrap());
    assert!(!state["files_touched"].as_array().unwrap().is_empty());
}

#[test]
fn compaction_body_forces_stream_false() {
    let body = json!({
        "model": "client-model",
        "stream": true,
        "messages": [{"role": "user", "content": "hi"}]
    });
    let compact = compaction_body(&body, "compact-model");
    assert_eq!(compact["model"], "compact-model");
    assert_eq!(compact["stream"], false);
    assert_eq!(compact["compaction"]["type"], "summarize");
}

#[test]
fn threshold_parsing_picks_bands_from_noul_scores() {
    assert_eq!(choice(Some(false), Some(false)).1, "mid_both_false");
    assert_eq!(choice(Some(true), Some(true)).1, "mid_both_true");
    assert_eq!(choice(None, Some(false)).1, "mid_unanswered");
    assert_eq!(choice(Some(true), Some(false)), (Complexity::High, "high"));
    assert_eq!(choice(Some(false), Some(true)), (Complexity::Low, "low"));

    let thresholds = Thresholds::default();
    let value = json!({
        "answers": {
            "is_easy": {"type": "noul", "noul": 0.81},
            "is_hard": {"type": "noul", "noul": 0.14},
            "tools_enough": {"type": "noul", "noul": 0.44}
        }
    });
    let row = classified(&value, &[], thresholds);
    assert_eq!(row.complexity, Complexity::Low);
    assert_eq!(row.choice_rule, "low");
    assert_eq!(row.is_easy, Some(true));
    assert_eq!(row.is_hard, Some(false));
    assert_eq!(row.is_easy_score, Some(0.81));
    assert_eq!(row.is_hard_score, Some(0.14));
    assert!(!row.tools_enough);

    let boundary = json!({
        "answers": {
            "is_easy": {"noul": 0.5},
            "is_hard": {"noul": 0.49}
        }
    });
    let row = classified(&boundary, &[], thresholds);
    assert_eq!((row.is_easy, row.is_hard), (Some(true), Some(false)));
    assert_eq!(row.choice_rule, "low");

    let words = json!({"is_easy": "false", "is_hard": "true"});
    let row = classified(&words, &[], thresholds);
    assert_eq!(row.choice_rule, "high");
    assert_eq!(row.is_hard_score, Some(1.0));
    assert_eq!(row.is_easy_score, Some(0.0));

    let missing = json!({"answers": {}});
    let row = classified(&missing, &[], thresholds);
    assert_eq!(row.choice_rule, "mid_unanswered");

    let scored = json!({
        "answers": {
            "is_hard": {"noul": 0.62},
            "is_easy": {"noul": 0.41}
        }
    });
    let default = classified(&scored, &[], Thresholds::default());
    assert_eq!(default.choice_rule, "high");
    assert_eq!(default.is_hard_score, Some(0.62));
    assert_eq!(default.is_easy_score, Some(0.41));
    let raised = classified(
        &scored,
        &[],
        Thresholds {
            hard: 0.7,
            easy: 0.5,
        },
    );
    assert_eq!(raised.choice_rule, "mid_both_false");
    assert_eq!(
        choice_from_scores(
            Some(0.6),
            Some(0.4),
            Thresholds {
                hard: 0.5,
                easy: 0.5
            }
        ),
        (Complexity::High, "high")
    );
    assert_eq!(
        choice_from_scores(
            Some(0.6),
            Some(0.4),
            Thresholds {
                hard: 0.7,
                easy: 0.5
            }
        ),
        (Complexity::Mid, "mid_both_false")
    );
    assert_eq!(
        choice_from_scores(
            Some(0.2),
            Some(0.8),
            Thresholds {
                hard: 0.5,
                easy: 0.5
            }
        ),
        (Complexity::Low, "low")
    );
}
