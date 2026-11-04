use serde_json::json;

use octo::auto::{
    context_estimate, dropped, filter_tools, is_housekeeping, needed_tools, needs_compact,
    output_reserve, session_id, session_key, Complexity, Tiers,
};

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
    assert_eq!(
        needed_tools(octo::auto::ToolNeed {
            all: &["Bash".into(), "Read".into()],
            current: &["Read".into()],
            enough: false,
            missing: &["Bash".into()],
        }),
        vec!["Read".to_string(), "Bash".to_string()]
    );
    let mut chat = json!({"tools": [{"type": "function", "function": {"name": "Bash"}}]});
    filter_tools(&mut chat, &["Bash".to_string()]);
    assert_eq!(chat["tools"].as_array().unwrap().len(), 1);
}
