use serde_json::json;

use octo::auto::context_length;
use octo::auto::{
    context_estimate, dropped, filter_tools, is_housekeeping, larger_fit, needed_tools,
    needs_compact, output_reserve, session_id, session_key, Complexity, LargerFit, Tiers,
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
