use serde_json::json;

use axum::http::StatusCode;
use axum::response::IntoResponse;
use octo::auto::context_length;
use octo::auto::{
    apply_sticky, cap_decision_text, cap_for_budget, choice, choice_from_scores, classified,
    compaction_body, context_estimate, decide, detect_stall, dropped, filter_tools, inspect,
    is_housekeeping, larger_fit, max_completion_tokens, needed_tools, needs_compact,
    output_reserve, payload, question_text, session_id, session_key, shape, with_model, Auto,
    Complexity, DecideRequest, LargerFit, PayloadPlan, RouteMeta, SessionChoice, ShapePlan,
    StallTrigger, StickyPlan, Thresholds, Tiers, Turn,
};
use octo::history::History;
use octo::providers::openrouter::{OpenRouterModel, OpenRouterModels};
use octo::proxy::error::ProxyError;

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
    assert!(is_housekeeping(
        "[SUGGESTION MODE: Suggest what the user might naturally type next"
    ));
    assert!(is_housekeeping(
        "The user stepped away and is coming back. Recap in under 40 words"
    ));
    assert!(is_housekeeping(
        "Current state: working\nWrite a 2-4 word lowercase label for this job"
    ));
    assert!(!is_housekeeping("what is about this branch"));
}

#[test]
fn housekeeping_fixture_title_session() {
    let text = "<session>\nHello world\n</session>\n\nWrite the title in the predominant language of the codebase.";
    assert!(is_housekeeping(text));
}

#[test]
fn question_text_strips_system_reminder_keeps_question() {
    let body = json!({
        "messages": [{
            "role": "user",
            "content": [
                {
                    "type": "text",
                    "text": "<system-reminder>\nYou are Claude Code. Mention tests often.\n</system-reminder>\n\nКакой порт слушает Octo?"
                }
            ]
        }]
    });
    assert_eq!(question_text(&body), "Какой порт слушает Octo?");
    let facts = inspect(&body, &question_text(&body));
    assert!(!facts.mentions_tests);
}

#[test]
fn question_text_keeps_session_and_conversation_inner() {
    let body = json!({
        "messages": [{
            "role": "user",
            "content": "<session>\nHello world\n</session>\n<conversation>ping</conversation>"
        }]
    });
    assert_eq!(question_text(&body), "Hello world\n\nping");
}

#[test]
fn decision_text_caps_at_2000_chars() {
    let long: String = "я".repeat(2500);
    let capped = cap_decision_text(&long);
    assert_eq!(capped.chars().count(), 2000);
}

#[test]
fn route_meta_rerouting_matches_tier_change() {
    let changed = RouteMeta::from_plan("low".into(), "mid".into(), Some("reclassify"));
    assert_eq!(changed.rerouting(), 1);
    assert_eq!(changed.trigger, "reclassify");
    let same = RouteMeta::housekeeping("mid");
    assert_eq!(same.tier_before, "mid");
    assert_eq!(same.tier_after, "low");
    assert_eq!(same.rerouting(), 1);
    assert_eq!(same.trigger, "housekeeping");
}

#[test]
fn session_budget_cap_clamps_high_to_mid() {
    let tiers = Tiers::new("low-model".into(), "mid-model".into(), "high-model".into());
    let mut tiers = tiers;
    tiers.session_budget_micros = 100;
    let mut sticky = apply_sticky(StickyPlan {
        tiers: &tiers,
        choice: None,
        classified: Complexity::High,
        preferred: None,
        stall: None,
        tool_results_only: false,
    });
    cap_for_budget(&mut sticky, &tiers, 100);
    assert_eq!(sticky.sticky_band, "mid");
    assert_eq!(sticky.model, "mid-model");
    assert_eq!(sticky.reason.as_deref(), Some("budget_cap"));
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
        "high-model"
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
        max_completion_tokens: None,
        supported_parameters: Vec::new(),
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
fn high_pick_honours_preferred_only_when_allowlisted() {
    let mut tiers = Tiers::new(
        "google/gemma".into(),
        "deepseek/flash".into(),
        "~anthropic/claude-haiku-latest".into(),
    );
    assert_eq!(
        tiers.pick(Complexity::High, Some("custom/high")),
        "~anthropic/claude-haiku-latest"
    );
    tiers.high_allow = vec!["custom/high".into(), "~anthropic/claude-sonnet-4.5".into()];
    assert_eq!(
        tiers.pick(Complexity::High, Some("~google/gemma")),
        "~anthropic/claude-haiku-latest"
    );
    assert_eq!(
        tiers.pick(Complexity::High, Some("custom/high")),
        "custom/high"
    );
    assert_eq!(
        tiers.pick(Complexity::High, Some("anthropic/claude-sonnet-4.5")),
        "anthropic/claude-sonnet-4.5"
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

fn tool_use(name: &str, input: serde_json::Value) -> serde_json::Value {
    json!({"type": "tool_use", "name": name, "input": input})
}

fn assistant(blocks: Vec<serde_json::Value>) -> serde_json::Value {
    json!({"role": "assistant", "content": blocks})
}

fn user_error() -> serde_json::Value {
    json!({
        "role": "user",
        "content": [{"type": "tool_result", "is_error": true, "content": "boom"}]
    })
}

#[test]
fn stall_detects_repeated_call_error_streak_and_edit_streak() {
    let input = json!({"file_path": "a.rs", "old_string": "x", "new_string": "y"});
    let repeated = json!({
        "messages": [
            {"role": "user", "content": "go"},
            assistant(vec![tool_use("Bash", input.clone())]),
            user_error(),
            assistant(vec![tool_use("Bash", input.clone())]),
            user_error(),
            assistant(vec![tool_use("Bash", input.clone())]),
            user_error(),
        ]
    });
    assert_eq!(detect_stall(&repeated, 6), Some(StallTrigger::RepeatedCall));

    let errors = json!({
        "messages": [
            {"role": "user", "content": "go"},
            assistant(vec![tool_use("Bash", json!({"command": "1"}))]),
            user_error(),
            assistant(vec![tool_use("Bash", json!({"command": "2"}))]),
            user_error(),
            assistant(vec![tool_use("Bash", json!({"command": "3"}))]),
            user_error(),
        ]
    });
    assert_eq!(detect_stall(&errors, 6), Some(StallTrigger::ErrorStreak));

    let user_ok = json!({
        "role": "user",
        "content": [{"type": "tool_result", "is_error": false, "content": "ok"}]
    });
    let edits = json!({
        "messages": [
            {"role": "user", "content": "edit"},
            assistant(vec![tool_use("Edit", json!({"file_path": "a"}))]),
            user_ok.clone(),
            assistant(vec![tool_use("Edit", json!({"file_path": "b"}))]),
            user_ok.clone(),
            assistant(vec![tool_use("StrReplace", json!({"file_path": "c"}))]),
            user_ok.clone(),
            assistant(vec![tool_use("Edit", json!({"file_path": "d"}))]),
            user_ok.clone(),
            assistant(vec![tool_use("Edit", json!({"file_path": "e"}))]),
            user_ok.clone(),
            assistant(vec![tool_use("Edit", json!({"file_path": "f"}))]),
            user_ok,
        ]
    });
    assert_eq!(detect_stall(&edits, 6), Some(StallTrigger::EditStreak));

    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/stall_repeated_edit.json")).unwrap();
    assert!(detect_stall(&fixture, 6).is_some());
}

#[test]
fn stall_escalates_then_releases_and_down_needs_confirm() {
    let mut tiers = Tiers::new("low-m".into(), "mid-m".into(), "high-m".into());
    tiers.escalate_turns = 3;
    tiers.down_confirm = 2;

    let escalated = apply_sticky(StickyPlan {
        tiers: &tiers,
        choice: None,
        classified: Complexity::Low,
        preferred: None,
        stall: Some(StallTrigger::RepeatedCall),
        tool_results_only: false,
    });
    assert_eq!(escalated.model, "mid-m");
    assert_eq!(
        escalated.reason.as_deref(),
        Some("stall_escalate:repeated_call")
    );
    assert_eq!(escalated.escalate_remaining, 3);

    let mut choice = SessionChoice::fresh("mid-m".into(), vec!["Edit".into()], "low".into());
    choice.escalate_remaining = 3;
    choice.escalate_band = Some("mid".into());
    choice.last_stall = Some("repeated_call".into());

    let mut current = choice;
    for expect in [2, 1] {
        let next = apply_sticky(StickyPlan {
            tiers: &tiers,
            choice: Some(&current),
            classified: Complexity::Low,
            preferred: None,
            stall: None,
            tool_results_only: false,
        });
        assert_eq!(next.model, "mid-m");
        assert_eq!(next.escalate_remaining, expect);
        current.escalate_remaining = next.escalate_remaining;
        current.escalate_band = next.escalate_band.clone();
        current.model = next.model.clone();
    }
    let released = apply_sticky(StickyPlan {
        tiers: &tiers,
        choice: Some(&current),
        classified: Complexity::Low,
        preferred: None,
        stall: None,
        tool_results_only: false,
    });
    assert_eq!(released.model, "low-m");
    assert_eq!(released.reason.as_deref(), Some("stall_release"));
    assert_eq!(released.escalate_remaining, 0);

    let sticky = SessionChoice::fresh("mid-m".into(), vec![], "mid".into());
    let hold = apply_sticky(StickyPlan {
        tiers: &tiers,
        choice: Some(&sticky),
        classified: Complexity::Low,
        preferred: None,
        stall: None,
        tool_results_only: false,
    });
    assert_eq!(hold.model, "mid-m");
    assert_eq!(hold.reason.as_deref(), Some("hysteresis_hold"));
    assert_eq!(hold.down_count, 1);

    let mut pending = sticky.clone();
    pending.pending_down_band = Some("low".into());
    pending.down_count = 1;
    let dropped = apply_sticky(StickyPlan {
        tiers: &tiers,
        choice: Some(&pending),
        classified: Complexity::Low,
        preferred: None,
        stall: None,
        tool_results_only: false,
    });
    assert_eq!(dropped.model, "low-m");
    assert_eq!(dropped.sticky_band, "low");
    assert_eq!(dropped.down_count, 0);

    let mut escalated_mid = SessionChoice::fresh("mid-m".into(), vec![], "low".into());
    escalated_mid.escalate_remaining = 2;
    escalated_mid.escalate_band = Some("mid".into());
    let up_wins = apply_sticky(StickyPlan {
        tiers: &tiers,
        choice: Some(&escalated_mid),
        classified: Complexity::High,
        preferred: None,
        stall: None,
        tool_results_only: false,
    });
    assert_eq!(up_wins.sticky_band, "high");
    assert_eq!(up_wins.model, "high-m");
    assert_eq!(up_wins.escalate_remaining, 1);
}

#[test]
fn shape_strips_thinking_only_on_model_change_and_clamps_tokens() {
    let body = json!({
        "model": "old-model",
        "max_tokens": 100000,
        "thinking": {"type": "enabled"},
        "tools": [{"name": "Bash"}, {"name": "Read"}],
        "messages": [
            {"role": "assistant", "content": [
                {"type": "thinking", "thinking": "secret"},
                {"type": "redacted_thinking", "data": "x"},
                {"type": "text", "text": "hi"}
            ]}
        ]
    });
    let models = OpenRouterModels {
        free: Vec::new(),
        paid: vec![OpenRouterModel {
            id: "new-model".into(),
            name: "new".into(),
            is_free: false,
            context_length: Some(32_000),
            max_completion_tokens: Some(4096),
            supported_parameters: vec!["max_tokens".into()],
        }],
    };
    let same = shape(ShapePlan {
        body: &body,
        model: "old-model",
        previous_model: Some("old-model"),
        models: Some(&models),
    });
    assert!(same["messages"][0]["content"]
        .as_array()
        .unwrap()
        .iter()
        .any(|part| part["type"] == "thinking"));

    let changed = shape(ShapePlan {
        body: &body,
        model: "new-model",
        previous_model: Some("old-model"),
        models: Some(&models),
    });
    let parts = changed["messages"][0]["content"].as_array().unwrap();
    assert!(parts.iter().all(|part| part["type"] != "thinking"));
    assert!(parts.iter().all(|part| part["type"] != "redacted_thinking"));
    assert_eq!(changed["max_tokens"], 4096);
    assert!(changed.get("thinking").is_none());
    assert_eq!(
        changed["tools"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|tool| tool["name"].as_str())
            .collect::<Vec<_>>(),
        vec!["Bash", "Read"]
    );
    assert_eq!(
        max_completion_tokens(Some(&models), "new-model"),
        Some(4096)
    );

    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/claude_code_messages.json")).unwrap();
    let shaped = shape(ShapePlan {
        body: &fixture,
        model: "mid-model",
        previous_model: Some("claude-sonnet-4-5"),
        models: Some(&models),
    });
    assert_eq!(
        shaped["tools"].as_array().unwrap().len(),
        fixture["tools"].as_array().unwrap().len()
    );
}

#[tokio::test]
async fn decide_stall_escalates_without_catalog_or_jev() {
    let mut tiers = Tiers::new("low-m".into(), "mid-m".into(), "high-m".into());
    tiers.escalate_turns = 3;
    let auto = Auto::new(tiers);
    let history = History::disabled();
    let client = reqwest::Client::new();
    let body: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/stall_repeated_edit.json")).unwrap();
    assert!(detect_stall(&body, 6).is_some());
    let turn = decide(DecideRequest {
        auto: &auto,
        history: &history,
        client: &client,
        decisions_url: "http://127.0.0.1:9/decisions",
        api_key: "",
        body,
        allow_compact: true,
    })
    .await;
    let Turn::Forward(forward) = turn else {
        panic!("expected forward");
    };
    let payload: serde_json::Value = serde_json::from_slice(&forward.body).unwrap();
    assert_eq!(payload["model"], "mid-m");
    assert!(
        forward.meta.trigger.starts_with("stall:"),
        "trigger={:?}",
        forward.meta.trigger
    );
}

#[tokio::test]
async fn housekeeping_forces_low_even_when_stall_present() {
    let mut tiers = Tiers::new("low-m".into(), "mid-m".into(), "high-m".into());
    tiers.escalate_turns = 3;
    let auto = Auto::new(tiers);
    let history = History::disabled();
    let client = reqwest::Client::new();
    let mut body: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/stall_repeated_edit.json")).unwrap();
    let messages = body["messages"].as_array_mut().unwrap();
    messages.push(json!({
        "role": "user",
        "content": "[SUGGESTION MODE: Suggest what the user might type next"
    }));
    let turn = decide(DecideRequest {
        auto: &auto,
        history: &history,
        client: &client,
        decisions_url: "http://127.0.0.1:9/decisions",
        api_key: "",
        body,
        allow_compact: true,
    })
    .await;
    let Turn::Forward(forward) = turn else {
        panic!("expected forward");
    };
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&forward.body).unwrap()["model"],
        "low-m"
    );
    assert_eq!(forward.meta.trigger, "housekeeping");
    assert_eq!(forward.meta.tier_after, "low");
}

#[tokio::test]
async fn housekeeping_forces_low_without_touching_sticky() {
    let mut tiers = Tiers::new("low-m".into(), "mid-m".into(), "high-m".into());
    tiers.session_budget_micros = 100;
    let auto = Auto::new(tiers);
    let mut seeded = SessionChoice::fresh("high-m".into(), vec!["Read".into()], "high".into());
    seeded.escalate_remaining = 2;
    seeded.escalate_band = Some("mid".into());
    auto.seed_session("hk-sess", seeded);
    auto.add_session_cost("hk-sess", 150);
    let history = History::disabled();
    let client = reqwest::Client::new();
    let housekeeping = json!({
        "metadata": {"user_id": "{\"session_id\":\"hk-sess\"}"},
        "tools": [{"name": "Read"}],
        "messages": [{"role": "user", "content": "Write a 2-4 word lowercase label for this job"}]
    });
    let turn = decide(DecideRequest {
        auto: &auto,
        history: &history,
        client: &client,
        decisions_url: "http://127.0.0.1:9/decisions",
        api_key: "",
        body: housekeeping,
        allow_compact: true,
    })
    .await;
    let Turn::Forward(forward) = turn else {
        panic!("expected forward");
    };
    let payload: serde_json::Value = serde_json::from_slice(&forward.body).unwrap();
    assert_eq!(payload["model"], "low-m");
    assert_eq!(forward.meta.trigger, "housekeeping");
    assert_eq!(forward.meta.tier_before, "high");
    assert_eq!(forward.meta.tier_after, "low");
    assert_eq!(auto.session_cost_micros("hk-sess"), 150);

    let follow = decide(DecideRequest {
        auto: &auto,
        history: &history,
        client: &client,
        decisions_url: "http://127.0.0.1:9/decisions",
        api_key: "",
        body: json!({
            "metadata": {"user_id": "{\"session_id\":\"hk-sess\"}"},
            "tools": [{"name": "Read"}],
            "messages": [{"role": "user", "content": ""}]
        }),
        allow_compact: true,
    })
    .await;
    let Turn::Forward(held) = follow else {
        panic!("expected forward hold");
    };
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&held.body).unwrap()["model"],
        "mid-m"
    );
    assert_eq!(held.meta.trigger, "budget_cap");
}

#[tokio::test]
async fn empty_question_after_strip_holds_current_model() {
    let tiers = Tiers::new("low-m".into(), "mid-m".into(), "high-m".into());
    let auto = Auto::new(tiers);
    auto.seed_session(
        "empty-q",
        SessionChoice::fresh("mid-m".into(), vec!["Read".into()], "mid".into()),
    );
    let history = History::disabled();
    let client = reqwest::Client::new();
    let turn = decide(DecideRequest {
        auto: &auto,
        history: &history,
        client: &client,
        decisions_url: "http://127.0.0.1:9/decisions",
        api_key: "sk-would-call-jev",
        body: json!({
            "metadata": {"user_id": "{\"session_id\":\"empty-q\"}"},
            "tools": [{"name": "Read"}],
            "messages": [{
                "role": "user",
                "content": "<system-reminder>\nOnly noise here.\n</system-reminder>"
            }]
        }),
        allow_compact: true,
    })
    .await;
    let Turn::Forward(forward) = turn else {
        panic!("expected forward");
    };
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&forward.body).unwrap()["model"],
        "mid-m"
    );
    assert_eq!(forward.meta.trigger, "none");
}

#[tokio::test]
async fn housekeeping_bypasses_awaiting_compact() {
    let tiers = Tiers::new("low-m".into(), "mid-m".into(), "high-m".into());
    let auto = Auto::new(tiers);
    let mut seeded = SessionChoice::fresh("high-m".into(), vec!["Read".into()], "high".into());
    seeded.awaiting_compact = true;
    seeded.prev_input_tokens_est = 1;
    auto.seed_session("hk-compact", seeded);
    let history = History::disabled();
    let client = reqwest::Client::new();
    let turn = decide(DecideRequest {
        auto: &auto,
        history: &history,
        client: &client,
        decisions_url: "http://127.0.0.1:9/decisions",
        api_key: "",
        body: json!({
            "metadata": {"user_id": "{\"session_id\":\"hk-compact\"}"},
            "tools": [{"name": "Read"}],
            "messages": [{"role": "user", "content": "[SUGGESTION MODE: Suggest next"}]
        }),
        allow_compact: true,
    })
    .await;
    let Turn::Forward(forward) = turn else {
        panic!("expected forward, got compact or other");
    };
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&forward.body).unwrap()["model"],
        "low-m"
    );
    assert_eq!(forward.meta.trigger, "housekeeping");
}

#[tokio::test]
async fn housekeeping_writes_no_decisions_row() {
    let tiers = Tiers::new("low-m".into(), "mid-m".into(), "high-m".into());
    let auto = Auto::new(tiers);
    let history = History::connect("sqlite::memory:", "test-key", 64)
        .await
        .unwrap();
    let client = reqwest::Client::new();
    let turn = decide(DecideRequest {
        auto: &auto,
        history: &history,
        client: &client,
        decisions_url: "http://127.0.0.1:9/decisions",
        api_key: "sk-test",
        body: json!({
            "metadata": {"user_id": "{\"session_id\":\"hk-dec\"}"},
            "tools": [{"name": "Read"}],
            "messages": [{"role": "user", "content": "[SUGGESTION MODE: Suggest next"}]
        }),
        allow_compact: true,
    })
    .await;
    let Turn::Forward(forward) = turn else {
        panic!("expected forward");
    };
    assert_eq!(forward.meta.trigger, "housekeeping");
    history.drain().await;
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM decisions WHERE session_id = ?")
        .bind("hk-dec")
        .fetch_one(history.pool().expect("pool"))
        .await
        .unwrap();
    assert_eq!(count, 0);
}

#[tokio::test]
async fn anthropic_proxy_error_body_shape() {
    let response = ProxyError::anthropic(
        StatusCode::BAD_GATEWAY,
        "api_error",
        "upstream request failed",
    )
    .into_response();
    assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let value: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(value["type"], "error");
    assert_eq!(value["error"]["type"], "api_error");
    assert_eq!(value["error"]["message"], "upstream request failed");

    let mapped = ProxyError::BodyTooLarge
        .as_anthropic_messages()
        .into_response();
    let body = axum::body::to_bytes(mapped.into_body(), usize::MAX)
        .await
        .unwrap();
    let value: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(value["error"]["type"], "invalid_request_error");
}
