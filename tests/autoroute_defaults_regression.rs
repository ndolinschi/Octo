use serde_json::json;

use octo::auto::{decide, shape, Auto, DecideRequest, SessionChoice, ShapePlan, Tiers, Turn};
use octo::history::History;

#[tokio::test]
async fn default_flags_preserve_fixture_triggers_and_bodies() {
    let tiers = Tiers::new("low-m".into(), "mid-m".into(), "high-m".into());
    assert!(!tiers.background_by_client_model);
    assert_eq!(tiers.server_tool_mode, "passthrough");
    let auto = Auto::new(tiers);
    auto.seed_session(
        "reg-sess",
        SessionChoice::fresh("mid-m".into(), vec!["Read".into()], "mid".into()),
    );
    let history = History::disabled();
    let client = reqwest::Client::new();

    let cases = [
        (
            "haiku_user_question",
            json!({
                "model": "claude-haiku-4-5",
                "metadata": {"user_id": "{\"session_id\":\"reg-sess\"}"},
                "tools": [{"name": "Read"}],
                "messages": [{"role": "user", "content": "what is the port?"}]
            }),
            "mid-m",
            false,
        ),
        (
            "permission_check",
            {
                let mut body: serde_json::Value =
                    serde_json::from_str(include_str!("fixtures/permission_check.json")).unwrap();
                body["metadata"] = json!({"user_id": "{\"session_id\":\"reg-sess\"}"});
                body
            },
            "mid-m",
            true,
        ),
        (
            "housekeeping",
            json!({
                "model": "claude-sonnet-4-5",
                "metadata": {"user_id": "{\"session_id\":\"reg-sess\"}"},
                "tools": [{"name": "Read"}],
                "messages": [{"role": "user", "content": "Write a 2-4 word lowercase label for this job"}]
            }),
            "low-m",
            true,
        ),
        (
            "server_tool_passthrough",
            json!({
                "model": "claude-sonnet-4-5",
                "metadata": {"user_id": "{\"session_id\":\"reg-sess\"}"},
                "tools": [
                    {"type": "web_search_20250305"},
                    {"name": "Read", "input_schema": {"type": "object"}}
                ],
                "messages": [{"role": "user", "content": ""}]
            }),
            "mid-m",
            false,
        ),
    ];

    for (name, body, expected_model, expect_special_trigger) in cases {
        let turn = decide(DecideRequest {
            auto: &auto,
            history: &history,
            client: &client,
            decisions_url: "http://127.0.0.1:9/decisions",
            api_key: "",
            body: body.clone(),
            allow_compact: true,
        })
        .await;
        let Turn::Forward(forward) = turn else {
            panic!("{name}: expected forward");
        };
        let payload: serde_json::Value = serde_json::from_slice(&forward.body).unwrap();
        assert_eq!(
            payload["model"], expected_model,
            "{name}: model changed under default flags"
        );
        assert_ne!(
            forward.meta.trigger, "background_model",
            "{name}: background routing must stay off by default"
        );
        if expect_special_trigger {
            assert!(
                forward.meta.trigger == "permission_check"
                    || forward.meta.trigger.starts_with("housekeeping"),
                "{name}: unexpected trigger {}",
                forward.meta.trigger
            );
        }
        if name == "server_tool_passthrough" {
            assert!(
                !payload["model"].as_str().unwrap().contains(":online"),
                "{name}: online_suffix must not apply in passthrough"
            );
            assert_eq!(
                payload["tools"], body["tools"],
                "{name}: tools must be unchanged"
            );
        }
        let shaped = shape(ShapePlan {
            body: &payload,
            model: payload["model"].as_str().unwrap_or("mid-m"),
            previous_model: payload["model"].as_str(),
            models: None,
            provider_order: &[],
            allow_fallbacks: true,
        });
        if let Some(provider) = shaped.get("provider").and_then(|p| p.as_object()) {
            assert!(
                !provider.contains_key("order"),
                "{name}: empty provider_order must not inject order"
            );
            assert!(
                !provider.contains_key("allow_fallbacks"),
                "{name}: empty provider_order must not inject allow_fallbacks"
            );
        }
    }
}
