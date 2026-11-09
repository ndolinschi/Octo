use serde_json::json;

use axum::http::StatusCode;
use axum::response::IntoResponse;
use octo::auto::context_length;
use octo::auto::{
    apply_sticky, asks_file_or_repo_inspection, bare_id, bg_signal, cap_decision_text,
    cap_for_budget, choice, choice_from_scores, classified, client_has_thinking,
    client_tool_names_csv, compaction_body, context_estimate, decide, default_strip_fields,
    detect_stall, dropped, fold_in_message_system, inspect, is_housekeeping, is_permission_check,
    is_subagent_key, larger_fit, looks_like_text_tool_call, max_completion_tokens, needed_tools,
    needs_compact, output_reserve, parent_session_id, payload, preferred_model, question_text,
    server_tool_types, session_id, session_key, shape, strip_model_marker, subagent_task_hash,
    trim_housekeeping, with_model, with_online_suffix, Auto, Complexity, DecideRequest, LargerFit,
    PayloadPlan, RequireParameters, RouteMeta, SessionChoice, ShapePlan, StallTrigger, StickyPlan,
    Thresholds, Tiers, Turn, PROTECTED_STRIP_FIELDS,
};
use octo::history::History;
use octo::providers::openrouter::{OpenRouterModel, OpenRouterModels};
use octo::proxy::error::ProxyError;

#[test]
fn fold_in_message_system_after_tool_result() {
    let mut body = json!({
        "system": "base",
        "messages": [
            {"role": "user", "content": "hi"},
            {"role": "assistant", "content": [{"type": "tool_use", "id": "t1", "name": "Bash", "input": {}}]},
            {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "t1", "content": "ok"}]},
            {"role": "system", "content": "Claude Code reminder"}
        ]
    });
    fold_in_message_system(&mut body);
    let messages = body["messages"].as_array().unwrap();
    assert_eq!(messages.len(), 3);
    assert!(messages.iter().all(|m| m["role"] != "system"));
    assert_eq!(body["system"], "base\n\nClaude Code reminder");

    let shaped = shape(ShapePlan::new(
        &json!({
            "model": "m",
            "messages": [
                {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "t1", "content": "x"}]},
                {"role": "system", "content": [{"type": "text", "text": "after tool"}]}
            ]
        }),
        "m",
        None,
        None,
    ))
    .body;
    assert!(shaped["messages"]
        .as_array()
        .unwrap()
        .iter()
        .all(|m| m["role"] != "system"));
    assert_eq!(shaped["system"], "after tool");
}

#[test]
fn strip_claude_code_model_marker_before_lookup() {
    assert_eq!(
        strip_model_marker("mistralai/devstral-2512[1m]"),
        "mistralai/devstral-2512"
    );
    assert_eq!(
        bare_id("~mistralai/devstral-2512[1m]"),
        "mistralai/devstral-2512"
    );
    let body = json!({"model": "mistralai/devstral-2512[1m]"});
    assert_eq!(
        preferred_model(&body).as_deref(),
        Some("mistralai/devstral-2512")
    );
    assert_eq!(
        with_model(&body, "mistralai/devstral-2512[1m]")["model"],
        "mistralai/devstral-2512"
    );
}

#[test]
fn tool_file_inspection_is_not_easy() {
    assert!(asks_file_or_repo_inspection("List files in apps/router"));
    assert!(!asks_file_or_repo_inspection("say hello"));
    let bumped = RouteMeta::from_plan("low".into(), "mid".into(), Some("reclassify"));
    assert_eq!(bumped.trigger, "reclassify");
    let stall_release = RouteMeta::from_plan("mid".into(), "low".into(), Some("stall_release"));
    assert_eq!(stall_release.trigger, "stall_release");
    let unknown = RouteMeta::from_plan("low".into(), "mid".into(), Some("band_up"));
    assert_eq!(unknown.trigger, "band_up");
}

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
        "system": "x-anthropic-billing-header: cc_version=1; cc_is_subagent=true;",
        "messages": [{"role": "user", "content": "explore the router"}]
    });
    let sub_key = session_key(&sub).unwrap();
    assert!(sub_key.starts_with("abc#sub:"), "{sub_key}");
    assert_eq!(parent_session_id(&sub_key), Some("abc"));
    assert!(is_subagent_key(&sub_key));
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
fn server_tool_modes_helpers() {
    let body = json!({
        "model": "mistralai/devstral-2512",
        "tools": [
            {"type": "web_search_20250305"},
            {"name": "Bash", "input_schema": {"type": "object"}}
        ]
    });
    assert_eq!(server_tool_types(&body), vec!["web_search_20250305"]);
    let online = with_online_suffix(&body);
    assert_eq!(online["model"], "mistralai/devstral-2512:online");
    let again = with_online_suffix(&online);
    assert_eq!(again["model"], "mistralai/devstral-2512:online");
    let passthrough = body.clone();
    assert_eq!(passthrough["model"], body["model"]);
}

#[test]
fn bg_signal_matches_haiku_patterns() {
    let patterns = vec!["haiku".to_string()];
    assert!(bg_signal(Some("claude-haiku-4-5-20251001"), &patterns));
    assert!(bg_signal(Some("anthropic/claude-3-haiku"), &patterns));
    assert!(!bg_signal(Some("claude-sonnet-4-5"), &patterns));
    assert!(!bg_signal(Some("claude-opus-4"), &patterns));
    assert!(!bg_signal(None, &patterns));
}

#[test]
fn client_observe_helpers_read_incoming_body() {
    let body = json!({
        "model": "claude-haiku-4-5",
        "thinking": {"type": "enabled"},
        "tools": [
            {"name": "Bash"},
            {"name": "Read"},
            {"type": "web_search_20250305", "name": "web_search"}
        ],
        "messages": [{"role": "user", "content": "hi"}]
    });
    assert!(client_has_thinking(&body));
    let names = client_tool_names_csv(&body);
    assert!(names.contains("Bash"));
    assert!(names.contains("Read"));
    assert!(names.contains("web_search") || names.contains("web_search_20250305"));
}

#[test]
fn permission_check_detector() {
    assert!(is_permission_check(
        "Claude Code is asking permission.\nErr on the side of blocking when unsure."
    ));
    assert!(is_permission_check(
        "  <transcript>\nuser asked for bash\n</transcript>"
    ));
    assert!(!is_permission_check("please implement the feature"));
}

#[tokio::test]
async fn background_by_client_model_off_matches_normal_path() {
    let tiers = Tiers::new("low-m".into(), "mid-m".into(), "high-m".into());
    let auto = Auto::new(tiers);
    auto.seed_session(
        "bg-off",
        SessionChoice::fresh("mid-m".into(), vec!["Read".into()], "mid".into()),
    );
    let history = History::disabled();
    let client = reqwest::Client::new();
    let body = json!({
        "model": "claude-haiku-4-5",
        "metadata": {"user_id": "{\"session_id\":\"bg-off\"}"},
        "tools": [{"name": "Read"}],
        "messages": [{"role": "user", "content": "what is the port?"}]
    });
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
    assert_ne!(forward.meta.trigger, "background_model");
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&forward.body).unwrap()["model"],
        "mid-m"
    );
}

#[tokio::test]
async fn background_by_client_model_on_forces_low_without_sticky() {
    let mut tiers = Tiers::new("low-m".into(), "mid-m".into(), "high-m".into());
    tiers.background_by_client_model = true;
    let auto = Auto::new(tiers);
    auto.seed_session(
        "bg-on",
        SessionChoice::fresh("high-m".into(), vec!["Read".into()], "high".into()),
    );
    let history = History::disabled();
    let client = reqwest::Client::new();
    let body = json!({
        "model": "claude-haiku-4-5",
        "metadata": {"user_id": "{\"session_id\":\"bg-on\"}"},
        "tools": [{"name": "Read"}],
        "messages": [{"role": "user", "content": "summarize this quietly"}]
    });
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
    assert_eq!(forward.meta.trigger, "background_model");
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&forward.body).unwrap()["model"],
        "low-m"
    );
    let hold = decide(DecideRequest {
        auto: &auto,
        history: &history,
        client: &client,
        decisions_url: "http://127.0.0.1:9/decisions",
        api_key: "",
        body: json!({
            "metadata": {"user_id": "{\"session_id\":\"bg-on\"}"},
            "tools": [{"name": "Read"}],
            "messages": [{"role": "user", "content": ""}]
        }),
        allow_compact: true,
    })
    .await;
    let Turn::Forward(held) = hold else {
        panic!("expected hold");
    };
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&held.body).unwrap()["model"],
        "high-m"
    );
}

#[tokio::test]
async fn permission_check_wins_over_background_model() {
    let mut tiers = Tiers::new("low-m".into(), "mid-m".into(), "high-m".into());
    tiers.background_by_client_model = true;
    let auto = Auto::new(tiers);
    auto.seed_session(
        "perm-bg",
        SessionChoice::fresh("high-m".into(), vec!["Bash".into()], "high".into()),
    );
    let history = History::disabled();
    let client = reqwest::Client::new();
    let mut body: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/permission_check.json")).unwrap();
    body["model"] = json!("claude-haiku-4-5");
    body["metadata"] = json!({"user_id": "{\"session_id\":\"perm-bg\"}"});
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
    assert_eq!(forward.meta.trigger, "permission_check");
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&forward.body).unwrap()["model"],
        "high-m"
    );
}

#[tokio::test]
async fn permission_check_keeps_current_model_without_sticky() {
    let tiers = Tiers::new("low-m".into(), "mid-m".into(), "high-m".into());
    let auto = Auto::new(tiers);
    let mut seeded = SessionChoice::fresh("high-m".into(), vec!["Bash".into()], "high".into());
    seeded.escalate_remaining = 2;
    seeded.escalate_band = Some("mid".into());
    auto.seed_session("perm-sess-1", seeded);
    let history = History::disabled();
    let client = reqwest::Client::new();
    let body: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/permission_check.json")).unwrap();
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
    assert_eq!(payload["model"], "high-m");
    assert_eq!(forward.meta.trigger, "permission_check");
    assert_eq!(forward.meta.tier_before, "high");
    assert_eq!(forward.meta.tier_after, "high");

    let follow = decide(DecideRequest {
        auto: &auto,
        history: &history,
        client: &client,
        decisions_url: "http://127.0.0.1:9/decisions",
        api_key: "",
        body: json!({
            "metadata": {"user_id": "{\"session_id\":\"perm-sess-1\"}"},
            "tools": [{"name": "Bash"}],
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
        "high-m"
    );
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
fn question_text_keeps_command_args_from_plan_slash_command() {
    let body = json!({
        "messages": [{
            "role": "user",
            "content": [
                {
                    "type": "text",
                    "text": "<system-reminder>\nIgnore this boilerplate.\n</system-reminder>\n<command-name>/plan</command-name>\n<command-message>plan</command-message>\n<command-args>Создай в папке ./taskq небольшую локальную очередь задач на Python.</command-args>\n<local-command-stdout>Enabled plan mode</local-command-stdout>"
                }
            ]
        }],
        "tools": [{"name": "Agent"}, {"name": "Bash"}]
    });
    let question = question_text(&body);
    assert!(
        question.contains("./taskq"),
        "command-args task must survive strip, got {question:?}"
    );
    assert!(!question.contains("Ignore this boilerplate"));
    assert!(!question.contains("Enabled plan mode"));
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

#[tokio::test]
async fn tool_results_only_hold_keeps_sticky_model_without_jev() {
    let tiers = Tiers::new("low-m".into(), "mid-m".into(), "high-m".into());
    let auto = Auto::new(tiers);
    auto.seed_session(
        "hold-sess",
        SessionChoice::fresh("mid-m".into(), vec!["Bash".into()], "mid".into()),
    );
    let history = History::disabled();
    let client = reqwest::Client::new();
    let body = json!({
        "metadata": {"user_id": "{\"session_id\":\"hold-sess\"}"},
        "model": "client",
        "max_tokens": 256,
        "tools": [{"name": "Bash"}],
        "messages": [{
            "role": "user",
            "content": [{
                "type": "tool_result",
                "tool_use_id": "1",
                "content": "ok"
            }]
        }]
    });
    let turn = decide(DecideRequest {
        auto: &auto,
        history: &history,
        client: &client,
        decisions_url: "http://127.0.0.1:9/decisions",
        api_key: "sk-would-call-jev",
        body,
        allow_compact: true,
    })
    .await;
    let Turn::Forward(forward) = turn else {
        panic!("expected forward");
    };
    let payload: serde_json::Value = serde_json::from_slice(&forward.body).unwrap();
    assert_eq!(payload["model"], "mid-m");
    assert_eq!(forward.meta.trigger, "none");
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
fn pick_respects_preference() {
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
}

#[test]
fn subagent_keys_hash_first_user_prompt() {
    let left = json!({
        "metadata": {"user_id": "{\"session_id\":\"uuid\"}"},
        "system": "x-anthropic-billing-header: cc_version=1; cc_is_subagent=true;",
        "messages": [
            {"role": "user", "content": "task alpha"},
            {"role": "assistant", "content": "ok"},
            {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "1", "content": "x"}]}
        ]
    });
    let right = json!({
        "metadata": {"user_id": "{\"session_id\":\"uuid\"}"},
        "system": "x-anthropic-billing-header: cc_version=1; cc_is_subagent=true;",
        "messages": [{"role": "user", "content": "task beta"}]
    });
    let same = json!({
        "metadata": {"user_id": "{\"session_id\":\"uuid\"}"},
        "system": "x-anthropic-billing-header: cc_version=1; cc_is_subagent=true;",
        "messages": [
            {"role": "user", "content": "task alpha"},
            {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "1", "content": "y"}]}
        ]
    });
    let left_key = session_key(&left).unwrap();
    let right_key = session_key(&right).unwrap();
    let same_key = session_key(&same).unwrap();
    assert_ne!(left_key, right_key);
    assert_eq!(left_key, same_key);
    assert_eq!(subagent_task_hash(&left), subagent_task_hash(&same));
    assert_eq!(parent_session_id(&left_key), Some("uuid"));
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
        Some(200_000)
    );
    assert_eq!(context_length(None, "missing/model"), None);
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
fn text_tool_call_detector_matches_agent_json_and_ignores_markdown_plan() {
    let tools = ["Agent", "Bash", "Read"];
    let agent_text = r#"[{"name": "Agent", "arguments": {"description": "Create task queue", "prompt": "build ./taskq"}}]"#;
    assert!(looks_like_text_tool_call(agent_text, &tools));
    assert!(looks_like_text_tool_call(
        r#"{"name":"Bash","arguments":{"command":"ls"}}"#,
        &tools
    ));
    assert!(looks_like_text_tool_call(
        "Here:\n<tool_call>\n{\"name\": \"Read\", \"arguments\": {\"file_path\": \"/tmp/a\"}}\n</tool_call>",
        &tools
    ));
    assert!(!looks_like_text_tool_call(
        "### Plan\n\n1. Create ./taskq\n2. Add tests\n",
        &tools
    ));
    assert!(!looks_like_text_tool_call(
        r#"[{"name": "NotATool", "arguments": {}}]"#,
        &tools
    ));
}

#[test]
fn detect_stall_flags_text_tool_call_in_last_assistant_message() {
    let body = json!({
        "tools": [
            {"name": "Agent", "input_schema": {"type": "object"}},
            {"name": "Bash", "input_schema": {"type": "object"}}
        ],
        "messages": [
            {"role": "user", "content": "build taskq"},
            {"role": "assistant", "content": [
                {"type": "text", "text": "[{\"name\": \"Agent\", \"arguments\": {\"description\": \"Create task queue\", \"prompt\": \"...\"}}]"}
            ]},
            {"role": "user", "content": "continue"}
        ]
    });
    assert_eq!(detect_stall(&body, 6), Some(StallTrigger::TextToolCall));
}

#[test]
fn text_tool_call_stall_escalates_mid_from_low() {
    let mut tiers = Tiers::new("low-m".into(), "mid-m".into(), "high-m".into());
    tiers.escalate_turns = 3;
    let escalated = apply_sticky(StickyPlan {
        tiers: &tiers,
        choice: None,
        classified: Complexity::Low,
        preferred: None,
        stall: Some(StallTrigger::TextToolCall),
        tool_results_only: false,
    });
    assert_eq!(escalated.model, "mid-m");
    assert_eq!(
        escalated.reason.as_deref(),
        Some("stall_escalate:text_tool_call")
    );
    assert_eq!(escalated.escalate_remaining, 3);
}

#[tokio::test]
async fn mark_text_tool_call_escalate_bumps_next_forward_model() {
    let mut tiers = Tiers::new("low-m".into(), "mid-m".into(), "high-m".into());
    tiers.escalate_turns = 2;
    let auto = Auto::new(tiers);
    auto.seed_session(
        "sess-ttc",
        SessionChoice::fresh("low-m".into(), vec!["Agent".into()], "low".into()),
    );
    auto.mark_text_tool_call_escalate("sess-ttc");
    let history = History::disabled();
    let client = reqwest::Client::new();
    let body = json!({
        "metadata": {"user_id": "{\"session_id\":\"sess-ttc\"}"},
        "model": "low-m",
        "max_tokens": 256,
        "tools": [{"name": "Agent"}],
        "messages": [{"role": "user", "content": "continue the task"}]
    });
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
    let outgoing: serde_json::Value = serde_json::from_slice(&forward.body).unwrap();
    assert_eq!(
        outgoing["model"], "mid-m",
        "session escalate from text_tool_call must bump model"
    );
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
    let same = shape(ShapePlan::new(
        &body,
        "old-model",
        Some("old-model"),
        Some(&models),
    ))
    .body;
    assert!(same["messages"][0]["content"]
        .as_array()
        .unwrap()
        .iter()
        .any(|part| part["type"] == "thinking"));

    let changed = shape(ShapePlan::new(
        &body,
        "new-model",
        Some("old-model"),
        Some(&models),
    ))
    .body;
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
    assert_eq!(
        changed["provider"]["require_parameters"], true,
        "tools present → require_parameters"
    );

    let no_tools = json!({
        "model": "old-model",
        "max_tokens": 100,
        "messages": [{"role": "user", "content": "hi"}]
    });
    let plain = shape(ShapePlan::new(&no_tools, "old-model", None, None)).body;
    assert_eq!(
        plain["provider"]["require_parameters"], true,
        "default require_parameters=always sets the flag even without tools"
    );
    let tools_only = shape(ShapePlan {
        body: &no_tools,
        model: "old-model",
        previous_model: None,
        models: None,
        provider_order: &[],
        allow_fallbacks: true,
        strip_fields: &[],
        require_parameters: RequireParameters::ToolsOnly,
    })
    .body;
    assert!(tools_only.get("provider").is_none());
    let never = shape(ShapePlan {
        body: &json!({
            "model": "old-model",
            "tools": [{"name": "Bash"}],
            "messages": [{"role": "user", "content": "hi"}]
        }),
        model: "old-model",
        previous_model: None,
        models: None,
        provider_order: &[],
        allow_fallbacks: true,
        strip_fields: &[],
        require_parameters: RequireParameters::Never,
    })
    .body;
    assert!(never.get("provider").is_none());

    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/claude_code_messages.json")).unwrap();
    let shaped = shape(ShapePlan::new(
        &fixture,
        "mid-model",
        Some("claude-sonnet-4-5"),
        Some(&models),
    ))
    .body;
    assert_eq!(
        shaped["tools"].as_array().unwrap().len(),
        fixture["tools"].as_array().unwrap().len()
    );
    assert_eq!(shaped["provider"]["require_parameters"], true);
}

#[test]
fn shape_strips_anthropic_only_fields_that_break_openrouter() {
    let body = json!({
        "model": "claude-sonnet-4-5",
        "max_tokens": 1024,
        "output_config": {"effort": "high"},
        "safeguards": {"something": true},
        "context_management": {
            "edits": [{"type": "clear_thinking_20251015", "keep": "all"}]
        },
        "tools": [{"name": "Bash", "input_schema": {"type": "object"}}],
        "messages": [{"role": "user", "content": "hi"}]
    });
    let result = shape(ShapePlan::new(
        &body,
        "mistralai/devstral-2512",
        Some("claude-sonnet-4-5"),
        None,
    ));
    let shaped = result.body;
    assert!(
        shaped.get("output_config").is_none(),
        "output_config + require_parameters 404s OpenRouter Mistral"
    );
    assert!(shaped.get("safeguards").is_none());
    assert!(
        shaped.get("context_management").is_none(),
        "context_management is unsupported on devstral and present only on 404 call 528"
    );
    assert_eq!(
        result.stripped,
        vec![
            "context_management".to_string(),
            "output_config".to_string(),
            "safeguards".to_string(),
        ]
    );
    assert_eq!(shaped["provider"]["require_parameters"], true);
    assert_eq!(shaped["model"], "mistralai/devstral-2512");
    let meta = RouteMeta::from_plan("unset".into(), "high".into(), Some("classify"))
        .with_stripped(&result.stripped);
    assert_eq!(meta.trigger, "classify");
    assert_eq!(
        meta.legacy_reason().as_deref(),
        Some("classify;stripped:context_management,output_config,safeguards")
    );
}

#[test]
fn shape_call_528_fixture_strips_proven_keys_keeps_rest() {
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/call_528_devstral_404.json")).unwrap();
    let before = fixture.clone();
    let result = shape(ShapePlan::new(
        &fixture,
        "mistralai/devstral-2512",
        Some("mistralai/devstral-2512"),
        None,
    ));
    let shaped = result.body;
    for key in ["output_config", "safeguards", "context_management"] {
        assert!(shaped.get(key).is_none(), "{key} must be stripped");
        assert!(before.get(key).is_some(), "{key} present in fixture");
    }
    assert_eq!(
        result.stripped,
        vec![
            "context_management".to_string(),
            "output_config".to_string(),
            "safeguards".to_string(),
        ]
    );
    assert_eq!(shaped["provider"]["require_parameters"], true);
    for key in before.as_object().unwrap().keys() {
        if matches!(
            key.as_str(),
            "output_config"
                | "safeguards"
                | "context_management"
                | "model"
                | "provider"
                | "messages"
                | "system"
        ) {
            continue;
        }
        assert_eq!(
            shaped.get(key),
            before.get(key),
            "non-stripped key {key} must stay byte-identical"
        );
    }
    assert!(shaped["messages"]
        .as_array()
        .unwrap()
        .iter()
        .all(|m| m["role"] != "system"));
    assert!(shaped.get("system").is_some());
    assert_eq!(shaped["model"], "mistralai/devstral-2512");
}

#[test]
fn shape_call_530_fixture_only_strips_output_config() {
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/call_530_housekeeping_ok.json")).unwrap();
    let before = fixture.clone();
    let strip = default_strip_fields();
    let result = shape(ShapePlan {
        body: &fixture,
        model: "mistralai/ministral-8b-2512",
        previous_model: None,
        models: None,
        provider_order: &[],
        allow_fallbacks: true,
        strip_fields: &strip,
        require_parameters: RequireParameters::ToolsOnly,
    });
    let shaped = result.body;
    assert!(shaped.get("output_config").is_none());
    assert_eq!(result.stripped, vec!["output_config".to_string()]);
    for key in before.as_object().unwrap().keys() {
        if key == "output_config" || key == "model" {
            continue;
        }
        assert_eq!(
            shaped.get(key),
            before.get(key),
            "call 530 key {key} must stay unchanged under tools_only"
        );
    }
    assert!(shaped.get("provider").is_none());
}

#[test]
fn shape_empty_strip_fields_disables_stripping() {
    let body = json!({
        "model": "m",
        "output_config": {"effort": "high"},
        "safeguards": {"x": true},
        "context_management": {"edits": []},
        "messages": [{"role": "user", "content": "hi"}]
    });
    let shaped = shape(ShapePlan {
        body: &body,
        model: "m",
        previous_model: None,
        models: None,
        provider_order: &[],
        allow_fallbacks: true,
        strip_fields: &[],
        require_parameters: RequireParameters::Never,
    });
    assert!(shaped.stripped.is_empty());
    assert_eq!(shaped.body["output_config"], json!({"effort": "high"}));
    assert_eq!(shaped.body["safeguards"], json!({"x": true}));
    assert_eq!(shaped.body["context_management"], json!({"edits": []}));
}

#[test]
fn shape_ignores_protected_strip_fields() {
    let body = json!({
        "model": "m",
        "output_config": {"effort": "high"},
        "tools": [{"name": "Bash"}],
        "messages": [{"role": "user", "content": "hi"}],
        "system": [{"type": "text", "text": "sys"}],
        "max_tokens": 32,
        "metadata": {"user_id": "{}"}
    });
    let mut fields = default_strip_fields();
    for protected in PROTECTED_STRIP_FIELDS {
        fields.push((*protected).to_string());
    }
    let shaped = shape(ShapePlan {
        body: &body,
        model: "m",
        previous_model: None,
        models: None,
        provider_order: &[],
        allow_fallbacks: true,
        strip_fields: &fields,
        require_parameters: RequireParameters::ToolsOnly,
    });
    assert_eq!(shaped.stripped, vec!["output_config".to_string()]);
    assert_eq!(shaped.body["tools"], body["tools"]);
    assert_eq!(shaped.body["messages"], body["messages"]);
    assert_eq!(shaped.body["system"], body["system"]);
    assert_eq!(shaped.body["max_tokens"], body["max_tokens"]);
    assert_eq!(shaped.body["metadata"], body["metadata"]);
}

#[test]
fn shape_default_config_preserves_existing_fixtures_except_strip_keys() {
    let fixtures: [(&str, serde_json::Value); 4] = [
        (
            "claude_code_messages",
            serde_json::from_str(include_str!("fixtures/claude_code_messages.json")).unwrap(),
        ),
        (
            "permission_check",
            serde_json::from_str(include_str!("fixtures/permission_check.json")).unwrap(),
        ),
        (
            "session_with_thinking",
            serde_json::from_str(include_str!("fixtures/session_with_thinking.json")).unwrap(),
        ),
        (
            "stall_repeated_edit",
            serde_json::from_str(include_str!("fixtures/stall_repeated_edit.json")).unwrap(),
        ),
    ];
    let strip = ["output_config", "safeguards", "context_management"];
    for (name, fixture) in fixtures {
        let model = fixture
            .get("model")
            .and_then(|v| v.as_str())
            .unwrap_or("mistralai/ministral-8b-2512");
        let result = shape(ShapePlan::new(&fixture, model, None, None));
        let shaped = result.body;
        for key in strip {
            assert!(
                shaped.get(key).is_none(),
                "{name}: {key} must be absent after shape"
            );
        }
        for key in fixture.as_object().unwrap().keys() {
            if strip.contains(&key.as_str()) || key == "model" || key == "provider" {
                continue;
            }
            assert_eq!(
                shaped.get(key),
                fixture.get(key),
                "{name}: key {key} must remain identical aside from strip/model/provider"
            );
        }
        assert_eq!(shaped["provider"]["require_parameters"], true);
    }
}

#[test]
fn shape_merges_provider_pin_without_dropping_require_parameters() {
    let body = json!({
        "model": "m",
        "tools": [{"name": "Bash"}],
        "messages": [{"role": "user", "content": "hi"}]
    });
    let order = vec!["Mistral".to_string()];
    let pinned = shape(ShapePlan {
        body: &body,
        model: "m",
        previous_model: None,
        models: None,
        provider_order: &order,
        allow_fallbacks: false,
        strip_fields: &[],
        require_parameters: RequireParameters::Always,
    })
    .body;
    assert_eq!(pinned["provider"]["require_parameters"], true);
    assert_eq!(pinned["provider"]["order"], json!(["Mistral"]));
    assert_eq!(pinned["provider"]["allow_fallbacks"], false);

    let with_client = json!({
        "model": "m",
        "tools": [{"name": "Bash"}],
        "provider": {
            "order": ["Anthropic"],
            "allow_fallbacks": true,
            "require_parameters": false
        },
        "messages": [{"role": "user", "content": "hi"}]
    });
    let kept = shape(ShapePlan {
        body: &with_client,
        model: "m",
        previous_model: None,
        models: None,
        provider_order: &order,
        allow_fallbacks: false,
        strip_fields: &[],
        require_parameters: RequireParameters::Always,
    })
    .body;
    assert_eq!(kept["provider"]["order"], json!(["Anthropic"]));
    assert_eq!(kept["provider"]["allow_fallbacks"], true);
    assert_eq!(kept["provider"]["require_parameters"], false);

    let empty = shape(ShapePlan::new(&body, "m", None, None)).body;
    assert_eq!(empty["provider"], json!({"require_parameters": true}));
}

#[test]
fn require_parameters_replaces_string_provider_with_object() {
    let body = json!({
        "model": "m",
        "messages": [{"role": "user", "content": "hi"}],
        "provider": "mistral"
    });
    let shaped = shape(ShapePlan {
        body: &body,
        model: "m",
        previous_model: None,
        models: None,
        provider_order: &[],
        allow_fallbacks: true,
        strip_fields: &[],
        require_parameters: RequireParameters::Always,
    })
    .body;
    assert_eq!(shaped["provider"], json!({"require_parameters": true}));
}

#[test]
fn trim_housekeeping_keeps_system_tools_and_valid_slice() {
    let mut body: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/claude_code_messages.json")).unwrap();
    let messages = body["messages"].as_array_mut().unwrap();
    for i in 0..8 {
        messages.insert(
            0,
            json!({
                "role": "user",
                "content": format!("old turn {i}")
            }),
        );
        messages.insert(
            1,
            json!({
                "role": "assistant",
                "content": [{"type": "text", "text": format!("reply {i}")}]
            }),
        );
    }
    messages.push(json!({
        "role": "user",
        "content": "Write the title in the predominant language of the codebase."
    }));
    let system = body["system"].clone();
    let tools = body["tools"].clone();
    let last = body["messages"]
        .as_array()
        .unwrap()
        .last()
        .cloned()
        .unwrap();
    let before = body["messages"].as_array().unwrap().len();
    let trimmed = trim_housekeeping(&body, 6, 12_000);
    assert!(trimmed.shortened);
    assert_eq!(trimmed.trimmed_from_tokens, Some(12_000));
    assert_eq!(trimmed.body["system"], system);
    assert_eq!(trimmed.body["tools"], tools);
    let after = trimmed.body["messages"].as_array().unwrap();
    assert!(after.len() < before);
    assert!(after.len() <= 6 + 2);
    assert_eq!(after.last().unwrap(), &last);
    assert_eq!(after.first().unwrap()["role"].as_str(), Some("user"));
    assert!(!after
        .first()
        .unwrap()
        .get("content")
        .and_then(|c| c.as_array())
        .map(|parts| parts.iter().all(|p| p["type"] == "tool_result"))
        .unwrap_or(false));
}

#[test]
fn trim_housekeeping_short_history_unchanged() {
    let body = json!({
        "system": "sys",
        "tools": [{"name": "Bash"}],
        "messages": [
            {"role": "user", "content": "hi"},
            {"role": "assistant", "content": "yo"},
            {"role": "user", "content": "Write the title in the predominant language"}
        ]
    });
    let trimmed = trim_housekeeping(&body, 6, 100);
    assert!(!trimmed.shortened);
    assert_eq!(trimmed.trimmed_from_tokens, None);
    assert_eq!(trimmed.body, body);
}

#[test]
fn trim_housekeeping_drops_orphan_tool_results() {
    let body = json!({
        "messages": [
            {"role": "user", "content": "start"},
            {"role": "assistant", "content": [
                {"type": "tool_use", "id": "old", "name": "Read", "input": {}}
            ]},
            {"role": "user", "content": [
                {"type": "tool_result", "tool_use_id": "old", "content": "gone"}
            ]},
            {"role": "assistant", "content": [
                {"type": "tool_use", "id": "keep", "name": "Read", "input": {}}
            ]},
            {"role": "user", "content": [
                {"type": "tool_result", "tool_use_id": "keep", "content": "ok"},
                {"type": "tool_result", "tool_use_id": "old", "content": "orphan"}
            ]},
            {"role": "user", "content": "Describe your most recent action in 3-5 words"}
        ]
    });
    let trimmed = trim_housekeeping(&body, 3, 500);
    assert!(trimmed.shortened);
    let msgs = trimmed.body["messages"].as_array().unwrap();
    let tool_results: Vec<&str> = msgs
        .iter()
        .filter(|m| m["role"] == "user")
        .flat_map(|m| m["content"].as_array().into_iter().flatten())
        .filter(|p| p["type"] == "tool_result")
        .filter_map(|p| p["tool_use_id"].as_str())
        .collect();
    assert!(tool_results.iter().all(|id| *id == "keep"));
    assert_eq!(
        msgs.last().unwrap()["content"],
        "Describe your most recent action in 3-5 words"
    );
}

#[tokio::test]
async fn housekeeping_trimmed_trigger_when_history_long() {
    let tiers = Tiers::new("low-m".into(), "mid-m".into(), "high-m".into());
    let auto = Auto::new(tiers);
    let history = History::disabled();
    let client = reqwest::Client::new();
    let mut body: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/claude_code_messages.json")).unwrap();
    let messages = body["messages"].as_array_mut().unwrap();
    for i in 0..10 {
        messages.push(json!({"role": "user", "content": format!("turn {i}")}));
        messages.push(json!({"role": "assistant", "content": format!("ok {i}")}));
    }
    messages.push(json!({
        "role": "user",
        "content": "Write the title in the predominant language of the codebase."
    }));
    let turn = decide(DecideRequest {
        auto: &auto,
        history: &history,
        client: &client,
        decisions_url: "http://127.0.0.1:9/decisions",
        api_key: "",
        body,
        allow_compact: false,
    })
    .await;
    let Turn::Forward(forward) = turn else {
        panic!("expected forward");
    };
    assert_eq!(forward.meta.trigger, "housekeeping_trimmed");
    assert!(forward.trimmed_from_tokens.is_some());
    let payload: serde_json::Value = serde_json::from_slice(&forward.body).unwrap();
    assert!(payload["messages"].as_array().unwrap().len() < 25);
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
    assert!(
        forward.meta.trigger.starts_with("housekeeping"),
        "trigger={:?}",
        forward.meta.trigger
    );
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
async fn passthrough_empty_question_still_strips_anthropic_only_fields() {
    let tiers = Tiers::new("low-m".into(), "mid-m".into(), "high-m".into());
    let auto = Auto::new(tiers);
    let history = History::disabled();
    let client = reqwest::Client::new();
    let turn = decide(DecideRequest {
        auto: &auto,
        history: &history,
        client: &client,
        decisions_url: "http://127.0.0.1:9/decisions",
        api_key: "sk-unused",
        body: json!({
            "model": "client-model",
            "output_config": {"effort": "high"},
            "safeguards": {"x": true},
            "context_management": {"edits": []},
            "tools": [{"name": "Bash"}],
            "messages": [{"role": "user", "content": "   "}]
        }),
        allow_compact: true,
    })
    .await;
    let Turn::Forward(forward) = turn else {
        panic!("expected passthrough forward");
    };
    assert_eq!(forward.meta.trigger, "none");
    assert_eq!(
        forward.meta.legacy_reason().as_deref(),
        Some("stripped:context_management,output_config,safeguards")
    );
    let payload: serde_json::Value = serde_json::from_slice(&forward.body).unwrap();
    assert!(payload.get("output_config").is_none());
    assert!(payload.get("safeguards").is_none());
    assert!(payload.get("context_management").is_none());
    assert_eq!(payload["provider"]["require_parameters"], true);
    assert_eq!(payload["model"], "client-model");
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
async fn housekeeping_skips_fill_upgrade_keeps_low() {
    let tiers = Tiers::new("low-m".into(), "mid-m".into(), "high-m".into());
    let auto = Auto::new(tiers);
    auto.seed_catalog(OpenRouterModels {
        free: Vec::new(),
        paid: vec![
            paid("low-m", 4_000),
            paid("mid-m", 200_000),
            paid("high-m", 200_000),
        ],
    })
    .await;
    let history = History::disabled();
    let client = reqwest::Client::new();
    let bulky = "x".repeat(12_000);
    let turn = decide(DecideRequest {
        auto: &auto,
        history: &history,
        client: &client,
        decisions_url: "http://127.0.0.1:9/decisions",
        api_key: "",
        body: json!({
            "metadata": {"user_id": "{\"session_id\":\"hk-fill\"}"},
            "max_tokens": 4096,
            "tools": [{"name": "Read"}],
            "messages": [{
                "role": "user",
                "content": format!("[SUGGESTION MODE: Suggest next]\n{bulky}")
            }]
        }),
        allow_compact: false,
    })
    .await;
    let Turn::Forward(forward) = turn else {
        panic!("expected forward without compact");
    };
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&forward.body).unwrap()["model"],
        "low-m"
    );
    assert_eq!(forward.meta.trigger, "housekeeping");
    assert_eq!(forward.meta.tier_after, "low");
}

#[tokio::test]
async fn housekeeping_trimmed_skips_fill_upgrade_keeps_low() {
    let tiers = Tiers::new("low-m".into(), "mid-m".into(), "high-m".into());
    let auto = Auto::new(tiers);
    auto.seed_catalog(OpenRouterModels {
        free: Vec::new(),
        paid: vec![
            paid("low-m", 4_000),
            paid("mid-m", 200_000),
            paid("high-m", 200_000),
        ],
    })
    .await;
    let history = History::disabled();
    let client = reqwest::Client::new();
    let bulky = "x".repeat(12_000);
    let mut messages = Vec::new();
    for i in 0..10 {
        messages.push(json!({"role": "user", "content": format!("turn {i}")}));
        messages.push(json!({"role": "assistant", "content": format!("ok {i}")}));
    }
    messages.push(json!({
        "role": "user",
        "content": format!("[SUGGESTION MODE: Suggest next]\n{bulky}")
    }));
    let turn = decide(DecideRequest {
        auto: &auto,
        history: &history,
        client: &client,
        decisions_url: "http://127.0.0.1:9/decisions",
        api_key: "",
        body: json!({
            "metadata": {"user_id": "{\"session_id\":\"hk-fill-trim\"}"},
            "max_tokens": 4096,
            "tools": [{"name": "Read"}],
            "messages": messages
        }),
        allow_compact: false,
    })
    .await;
    let Turn::Forward(forward) = turn else {
        panic!("expected forward without compact");
    };
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&forward.body).unwrap()["model"],
        "low-m"
    );
    assert_eq!(forward.meta.trigger, "housekeeping_trimmed");
    assert_eq!(forward.meta.tier_after, "low");
    assert!(forward.trimmed_from_tokens.is_some());
}

#[tokio::test]
async fn permission_check_skips_fill_upgrade_keeps_model() {
    let tiers = Tiers::new("low-m".into(), "mid-m".into(), "high-m".into());
    let auto = Auto::new(tiers);
    auto.seed_catalog(OpenRouterModels {
        free: Vec::new(),
        paid: vec![
            paid("low-m", 4_000),
            paid("mid-m", 200_000),
            paid("high-m", 200_000),
        ],
    })
    .await;
    auto.seed_session(
        "perm-fill",
        SessionChoice::fresh("low-m".into(), vec!["Bash".into()], "low".into()),
    );
    let history = History::disabled();
    let client = reqwest::Client::new();
    let bulky = "x".repeat(12_000);
    let turn = decide(DecideRequest {
        auto: &auto,
        history: &history,
        client: &client,
        decisions_url: "http://127.0.0.1:9/decisions",
        api_key: "",
        body: json!({
            "metadata": {"user_id": "{\"session_id\":\"perm-fill\"}"},
            "max_tokens": 4096,
            "tools": [{"name": "Bash"}],
            "messages": [{
                "role": "user",
                "content": format!(
                    "<transcript>\nuser: run bash\nassistant: needs permission\n</transcript>\n\
                     Err on the side of blocking when unsure.\n{bulky}"
                )
            }]
        }),
        allow_compact: false,
    })
    .await;
    let Turn::Forward(forward) = turn else {
        panic!("expected forward without compact");
    };
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&forward.body).unwrap()["model"],
        "low-m"
    );
    assert_eq!(forward.meta.trigger, "permission_check");
    assert_eq!(forward.meta.tier_after, "low");
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

#[tokio::test]
async fn subagent_first_turn_defaults_low_without_jev() {
    let tiers = Tiers::new("low-m".into(), "mid-m".into(), "high-m".into());
    let auto = Auto::new(tiers);
    let history = History::disabled();
    let client = reqwest::Client::new();
    let body = json!({
        "metadata": {"user_id": "{\"session_id\":\"parent-uuid\"}"},
        "system": "x-anthropic-billing-header: cc_version=1; cc_is_subagent=true;",
        "model": "client",
        "max_tokens": 256,
        "tools": [{"name": "Bash"}, {"name": "Read"}],
        "messages": [{"role": "user", "content": "explore the router module"}]
    });
    let key = session_key(&body).unwrap();
    assert!(key.starts_with("parent-uuid#sub:"));
    let turn = decide(DecideRequest {
        auto: &auto,
        history: &history,
        client: &client,
        decisions_url: "http://127.0.0.1:9/decisions",
        api_key: "sk-would-call-jev",
        body,
        allow_compact: true,
    })
    .await;
    let Turn::Forward(forward) = turn else {
        panic!("expected forward");
    };
    let payload: serde_json::Value = serde_json::from_slice(&forward.body).unwrap();
    assert_eq!(payload["model"], "low-m");
    assert_eq!(forward.meta.trigger, "subagent_default");
    assert_eq!(forward.meta.tier_after, "low");
    let snap = auto.session_snapshot(&key).unwrap();
    assert_eq!(snap.sticky_band, "low");
    assert_eq!(snap.model, "low-m");
}

#[tokio::test]
async fn subagent_stall_does_not_mutate_parent_sticky() {
    let mut tiers = Tiers::new("low-m".into(), "mid-m".into(), "high-m".into());
    tiers.escalate_turns = 2;
    let auto = Auto::new(tiers);
    auto.seed_session(
        "parent-uuid",
        SessionChoice::fresh("high-m".into(), vec!["Bash".into()], "high".into()),
    );
    let history = History::disabled();
    let client = reqwest::Client::new();
    let body = json!({
        "metadata": {"user_id": "{\"session_id\":\"parent-uuid\"}"},
        "system": "x-anthropic-billing-header: cc_version=1; cc_is_subagent=true;",
        "model": "client",
        "max_tokens": 256,
        "tools": [
            {"name": "Agent", "input_schema": {"type": "object"}},
            {"name": "Bash", "input_schema": {"type": "object"}}
        ],
        "messages": [
            {"role": "user", "content": "review the plan"},
            {"role": "assistant", "content": [
                {"type": "text", "text": "[{\"name\": \"Agent\", \"arguments\": {\"description\": \"x\", \"prompt\": \"y\"}}]"}
            ]},
            {"role": "user", "content": "continue"}
        ]
    });
    let sub_key = session_key(&body).unwrap();
    auto.seed_session(
        &sub_key,
        SessionChoice::fresh(
            "low-m".into(),
            vec!["Agent".into(), "Bash".into()],
            "low".into(),
        ),
    );
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
    assert!(forward.meta.trigger.contains("stall") || forward.meta.tier_after != "low");
    let parent = auto.session_snapshot("parent-uuid").unwrap();
    assert_eq!(parent.sticky_band, "high");
    assert_eq!(parent.model, "high-m");
    assert_eq!(parent.escalate_remaining, 0);
    let sub = auto.session_snapshot(&sub_key).unwrap();
    assert_ne!(
        (sub.model.as_str(), sub.sticky_band.as_str()),
        ("high-m", "high")
    );
}

#[tokio::test]
async fn budget_blocks_fill_upgrade_and_compacts_instead() {
    let mut tiers = Tiers::new("low-m".into(), "mid-m".into(), "high-m".into());
    tiers.session_budget_micros = 100;
    let auto = Auto::new(tiers);
    auto.seed_catalog(OpenRouterModels {
        free: Vec::new(),
        paid: vec![
            paid("low-m", 4_000),
            paid("mid-m", 4_000),
            paid("high-m", 200_000),
        ],
    })
    .await;
    auto.seed_session(
        "budget-fill",
        SessionChoice::fresh("mid-m".into(), vec!["Read".into()], "mid".into()),
    );
    auto.add_session_cost("budget-fill", 100);
    let history = History::disabled();
    let client = reqwest::Client::new();
    let bulky = "x".repeat(12_000);
    let turn = decide(DecideRequest {
        auto: &auto,
        history: &history,
        client: &client,
        decisions_url: "http://127.0.0.1:9/decisions",
        api_key: "",
        body: json!({
            "metadata": {"user_id": "{\"session_id\":\"budget-fill\"}"},
            "max_tokens": 4096,
            "tools": [{"name": "Read"}],
            "messages": [{"role": "user", "content": [{"type": "tool_result", "tool_use_id": "1", "content": bulky}]}]
        }),
        allow_compact: true,
    })
    .await;
    match turn {
        Turn::Compact(row) => {
            assert_eq!(row.model, "mid-m");
        }
        Turn::Forward(forward) => {
            let payload: serde_json::Value = serde_json::from_slice(&forward.body).unwrap();
            assert_ne!(payload["model"], "high-m");
            assert_eq!(payload["model"], "mid-m");
        }
    }
}

#[tokio::test]
async fn catalog_miss_skips_compact_on_large_body() {
    let tiers = Tiers::new("low-m".into(), "mid-m".into(), "high-m".into());
    let auto = Auto::new(tiers);
    auto.seed_session(
        "miss-sess",
        SessionChoice::fresh("mid-m".into(), vec!["Read".into()], "mid".into()),
    );
    let history = History::disabled();
    let client = reqwest::Client::new();
    let bulky = "x".repeat(80_000);
    let turn = decide(DecideRequest {
        auto: &auto,
        history: &history,
        client: &client,
        decisions_url: "http://127.0.0.1:9/decisions",
        api_key: "",
        body: json!({
            "metadata": {"user_id": "{\"session_id\":\"miss-sess\"}"},
            "max_tokens": 4096,
            "tools": [{"name": "Read"}],
            "messages": [{"role": "user", "content": [{"type": "tool_result", "tool_use_id": "1", "content": bulky}]}]
        }),
        allow_compact: true,
    })
    .await;
    let Turn::Forward(forward) = turn else {
        panic!("catalog miss must forward, not compact");
    };
    let payload: serde_json::Value = serde_json::from_slice(&forward.body).unwrap();
    assert_eq!(payload["model"], "mid-m");
}
