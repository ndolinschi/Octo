use serde_json::json;

use octo::auto::{
    context_estimate, dropped, filter_tools, needed_tools, needs_compact, pick_model, session_id,
    Complexity,
};

#[test]
fn session_id_comes_from_metadata_user_id() {
    let body = json!({
        "metadata": {
            "user_id": "{\"session_id\":\"abc\",\"device_id\":\"d\"}"
        }
    });
    assert_eq!(session_id(&body).as_deref(), Some("abc"));
}

#[test]
fn fill_and_drop_follow_the_window() {
    let estimate = context_estimate(4000, 5000, 4096);
    assert_eq!(estimate.input_tokens_est, 1000);
    assert!(estimate.usable < 1024);
    assert!(needs_compact(estimate));
    let roomy = context_estimate(400, 100_000, 4096);
    assert!(!needs_compact(roomy));
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
    assert_eq!(
        pick_model(Complexity::Low, Some("custom")),
        "google/gemma-4-26b-a4b-it"
    );
    assert_eq!(
        pick_model(Complexity::High, Some("google/gemma-4-26b-a4b-it")),
        "~anthropic/claude-haiku-latest"
    );
    assert_eq!(
        needed_tools(&["Bash".into(), "Read".into()], &["Read".into()], false),
        vec!["Bash".to_string(), "Read".to_string()]
    );
}
