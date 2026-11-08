use octo::history::{
    cost_micros_from_json, describe_input, request_payload, usage_from_output, CallKind,
    CallProvider, CostMicros, History, TokenCount,
};
use serde_json::Value;

#[tokio::test]
async fn same_secret_matches_and_raw_secret_is_not_the_hash() {
    let history = History::connect("sqlite::memory:", "server-key", 64)
        .await
        .unwrap();
    let left = history.token_hash("sk-user").unwrap();
    let right = history.token_hash("sk-user").unwrap();
    assert_eq!(left, right);
    assert_ne!(history.token_hash("sk-other").unwrap(), left);
    assert!(!left.contains("sk-user"));
}

#[test]
fn request_payload_tags_provider_and_preserves_json() {
    let raw = request_payload(
        CallKind::Llm,
        CallProvider::OpenAi,
        r#"{"model":"gpt-test","messages":[]}"#,
    );
    let value: Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(value["provider"], "openai");
    assert_eq!(value["payload"]["format"], "openai_chat_completions");
    assert_eq!(value["payload"]["body"]["model"], "gpt-test");
}

#[test]
fn openrouter_messages_response_payload_uses_anthropic_format() {
    use octo::history::response_payload;

    let output =
        "data: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":1}}}\n";
    let raw = response_payload(
        CallKind::Messages,
        CallProvider::OpenRouter,
        output,
        "",
        output.len(),
    );
    let value: Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(value["provider"], "openrouter");
    assert_eq!(value["payload"]["format"], "anthropic_messages");
}

#[test]
fn claude_response_payload_keeps_anthropic_events() {
    use octo::history::response_payload;

    let output =
        "data: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":1}}}\n";
    let raw = response_payload(
        CallKind::Messages,
        CallProvider::Claude,
        output,
        "",
        output.len(),
    );
    let value: Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(value["provider"], "claude");
    assert_eq!(value["payload"]["format"], "anthropic_messages");
    assert_eq!(value["payload"]["events"][0]["type"], "message_start");
}

#[test]
fn response_payload_does_not_duplicate_short_sse() {
    use octo::history::response_payload;

    let line = "data: {\"type\":\"ping\"}\n\n";
    let len = line.len();
    let raw = response_payload(CallKind::Llm, CallProvider::OpenAi, line, line, len);
    let value: Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(value["payload"]["events"].as_array().unwrap().len(), 1);
}

#[test]
fn describe_input_reads_model_and_last_user_message() {
    let (model, message) = describe_input(
        r#"{"model":"gpt-test","messages":[{"role":"user","content":"hello"},{"role":"assistant","content":"hi"},{"role":"user","content":[{"type":"text","text":"again"}]}]}"#,
    );
    assert_eq!(model.as_deref(), Some("gpt-test"));
    assert_eq!(message.as_deref(), Some("again"));
}

#[test]
fn usage_reads_sse_and_cost() {
    let output = "data: {\"choices\":[]}\n\ndata: {\"usage\":{\"prompt_tokens\":3,\"completion_tokens\":4,\"cost\":0.25}}\n\ndata: [DONE]\n";
    let usage = usage_from_output(output);
    assert_eq!(usage.input_tokens, Some(TokenCount(3)));
    assert_eq!(usage.output_tokens, Some(TokenCount(4)));
    assert_eq!(usage.cost, Some(CostMicros(250_000)));
}

#[test]
fn usage_reads_anthropic_message_events() {
    let output = "data: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":11,\"output_tokens\":1}}}\n\ndata: {\"type\":\"message_delta\",\"usage\":{\"output_tokens\":9}}\n";
    let usage = usage_from_output(output);
    assert_eq!(usage.input_tokens, Some(TokenCount(11)));
    assert_eq!(usage.output_tokens, Some(TokenCount(9)));
    assert_eq!(usage.cost, None);
}

#[test]
fn usage_reads_anthropic_cache_and_generation_id() {
    let output = concat!(
        "data: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_abc\",\"usage\":{",
        "\"input_tokens\":100,\"output_tokens\":1,",
        "\"cache_read_input_tokens\":40,\"cache_creation_input_tokens\":60}}}\n\n",
        "data: {\"type\":\"message_delta\",\"usage\":{\"output_tokens\":5}}\n"
    );
    let usage = usage_from_output(output);
    assert_eq!(usage.input_tokens, Some(TokenCount(100)));
    assert_eq!(usage.output_tokens, Some(TokenCount(5)));
    assert_eq!(usage.cache_read_tokens, Some(TokenCount(40)));
    assert_eq!(usage.cache_write_tokens, Some(TokenCount(60)));
    assert_eq!(usage.generation_id.as_deref(), Some("msg_abc"));
}

#[test]
fn usage_reads_openai_cached_tokens_and_id() {
    let output = concat!(
        "{\"id\":\"chatcmpl-xyz\",\"usage\":{\"prompt_tokens\":20,\"completion_tokens\":3,",
        "\"prompt_tokens_details\":{\"cached_tokens\":12},\"cost\":0.01}}"
    );
    let usage = usage_from_output(output);
    assert_eq!(usage.input_tokens, Some(TokenCount(20)));
    assert_eq!(usage.output_tokens, Some(TokenCount(3)));
    assert_eq!(usage.cache_read_tokens, Some(TokenCount(12)));
    assert_eq!(usage.cache_write_tokens, None);
    assert_eq!(usage.generation_id.as_deref(), Some("chatcmpl-xyz"));
    assert_eq!(usage.cost, Some(CostMicros(10_000)));
}

#[test]
fn decisions_usage_cost_parses_to_micros() {
    let body = serde_json::json!({"usage": {"cost": 0.000012}});
    assert_eq!(cost_micros_from_json(&body), Some(CostMicros(12)));
}

#[test]
fn whole_dollar_cost_scales_to_micros() {
    let body = serde_json::json!({"usage": {"cost": 1}});
    assert_eq!(cost_micros_from_json(&body), Some(CostMicros(1_000_000)));
    let usage =
        usage_from_output(r#"{"usage":{"prompt_tokens":1,"completion_tokens":1,"cost":1}}"#);
    assert_eq!(usage.cost, Some(CostMicros(1_000_000)));
}

#[test]
fn byok_sse_prefers_upstream_inference_cost() {
    use octo::history::{resolve_cost, CostSource, PriceTable};

    let output = concat!(
        r#"data: {"type":"message_start","message":{"id":"msg_x","provider":"Mistral","usage":{"input_tokens":10}}}"#,
        "\n\n",
        r#"data: {"type":"message_delta","usage":{"input_tokens":100,"output_tokens":5,"cost":0,"is_byok":true,"cost_details":{"upstream_inference_cost":0.0075}}}"#,
        "\n\n"
    );
    let usage = usage_from_output(output);
    assert_eq!(usage.or_cost, Some(CostMicros(0)));
    assert_eq!(usage.upstream_cost, Some(CostMicros(7_500)));
    assert_eq!(usage.is_byok, Some(true));
    assert_eq!(usage.upstream_provider.as_deref(), Some("Mistral"));
    let resolved = resolve_cost(
        &usage,
        Some("mistralai/devstral-2512"),
        &PriceTable::default(),
    );
    assert_eq!(resolved.source, CostSource::Upstream);
    assert_eq!(resolved.cost, Some(CostMicros(7_500)));
}

#[test]
fn estimate_cost_rounds_tiny_usage_to_zero_micros_not_none() {
    use octo::history::{resolve_cost, CostSource, ModelPrice, PriceTable};

    let usage = usage_from_output(
        r#"{"usage":{"input_tokens":1,"output_tokens":0,"cache_read_input_tokens":0,"cost":0}}"#,
    );
    let prices = PriceTable::new(vec![(
        "tiny-model".into(),
        ModelPrice {
            input: 0.000_001,
            cache_read: 0.0,
            cache_write: 0.0,
            output: 0.0,
            billed_as: None,
            rates_complete: true,
        },
    )]);
    let resolved = resolve_cost(&usage, Some("tiny-model"), &prices);
    assert_eq!(resolved.estimated_cost, Some(CostMicros(0)));
    assert_eq!(resolved.source, CostSource::None);
    assert_eq!(resolved.cost, None);
}

#[test]
fn zero_estimate_defers_to_nonzero_upstream() {
    use octo::history::{resolve_cost, CostSource, ModelPrice, PriceTable};

    let usage = usage_from_output(concat!(
        r#"{"usage":{"input_tokens":1,"output_tokens":0,"cache_read_input_tokens":0,"#,
        r#""cost":0,"is_byok":true,"cost_details":{"upstream_inference_cost":0.0075}}}"#
    ));
    let prices = PriceTable::new(vec![(
        "tiny-model".into(),
        ModelPrice {
            input: 0.000_001,
            cache_read: 0.0,
            cache_write: 0.0,
            output: 0.0,
            billed_as: None,
            rates_complete: true,
        },
    )]);
    let resolved = resolve_cost(&usage, Some("tiny-model"), &prices);
    assert_eq!(resolved.estimated_cost, Some(CostMicros(0)));
    assert_eq!(resolved.source, CostSource::Upstream);
    assert_eq!(resolved.cost, Some(CostMicros(7_500)));
}

#[test]
fn estimate_beats_upstream_when_prices_set() {
    use octo::history::{resolve_cost, CostSource, ModelPrice, PriceTable};

    let usage = usage_from_output(concat!(
        r#"{"usage":{"input_tokens":1000000,"output_tokens":0,"cache_read_input_tokens":0,"#,
        r#""cost":0,"is_byok":true,"cost_details":{"upstream_inference_cost":0.01}}}"#
    ));
    let prices = PriceTable::new(vec![(
        "mistralai/devstral-2512".into(),
        ModelPrice {
            input: 1.0,
            cache_read: 0.1,
            cache_write: 0.0,
            output: 2.0,
            billed_as: Some("mistral-medium-3-5".into()),
            rates_complete: true,
        },
    )]);
    let resolved = resolve_cost(&usage, Some("mistralai/devstral-2512"), &prices);
    assert_eq!(resolved.source, CostSource::Estimate);
    assert_eq!(resolved.estimated_cost, Some(CostMicros(1_000_000)));
    assert_eq!(resolved.cost, Some(CostMicros(1_000_000)));
}

#[test]
fn non_byok_openrouter_cost_used_when_no_estimate() {
    use octo::history::{resolve_cost, CostSource, PriceTable};

    let usage = usage_from_output(
        r#"{"usage":{"prompt_tokens":10,"completion_tokens":2,"cost":0.5,"is_byok":false}}"#,
    );
    let resolved = resolve_cost(&usage, Some("other"), &PriceTable::default());
    assert_eq!(resolved.source, CostSource::OpenRouter);
    assert_eq!(resolved.cost, Some(CostMicros(500_000)));
}

#[test]
fn no_usage_resolves_to_none() {
    use octo::history::{resolve_cost, CostSource, PriceTable};

    let usage = usage_from_output(r#"{"error":{"message":"User not found","code":401}}"#);
    let resolved = resolve_cost(&usage, None, &PriceTable::default());
    assert_eq!(resolved.source, CostSource::None);
    assert_eq!(resolved.cost, None);
}

#[test]
fn cache_read_priced_separately_from_uncached_input() {
    use octo::history::{resolve_cost, CostSource, ModelPrice, PriceTable};

    let usage = usage_from_output(concat!(
        r#"{"usage":{"input_tokens":1000000,"output_tokens":0,"#,
        r#""cache_read_input_tokens":400000,"cache_creation_input_tokens":0,"cost":0}}"#
    ));
    let prices = PriceTable::new(vec![(
        "mistralai/devstral-2512".into(),
        ModelPrice {
            input: 1.0,
            cache_read: 0.25,
            cache_write: 0.0,
            output: 0.0,
            billed_as: None,
            rates_complete: true,
        },
    )]);
    let resolved = resolve_cost(&usage, Some("mistralai/devstral-2512"), &prices);
    assert_eq!(resolved.source, CostSource::Estimate);
    assert_eq!(
        resolved.cost,
        Some(CostMicros(700_000)),
        "uncached 600k*$1 + cache_read 400k*$0.25 = $0.7"
    );
}

#[test]
fn partial_prices_fall_through_to_upstream() {
    use octo::history::{resolve_cost, CostSource, ModelPrice, PriceTable};

    let usage = usage_from_output(concat!(
        r#"{"usage":{"input_tokens":1000000,"output_tokens":0,"cache_read_input_tokens":0,"#,
        r#""cost":0,"is_byok":true,"cost_details":{"upstream_inference_cost":0.01}}}"#
    ));
    let prices = PriceTable::new(vec![(
        "mistralai/devstral-2512".into(),
        ModelPrice {
            input: 1.0,
            cache_read: 0.0,
            cache_write: 0.0,
            output: 0.0,
            billed_as: None,
            rates_complete: false,
        },
    )]);
    let resolved = resolve_cost(&usage, Some("mistralai/devstral-2512"), &prices);
    assert_eq!(resolved.source, CostSource::Upstream);
    assert_eq!(resolved.cost, Some(CostMicros(10_000)));
    assert!(resolved.estimated_cost.is_none());
}

#[test]
fn partial_prices_toml_loader_marks_rates_incomplete() {
    use octo::config::Config;
    use octo::history::{resolve_cost, CostSource};

    let dir = std::env::temp_dir().join(format!(
        "octo-prices-partial-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    for name in [
        "server.toml",
        "upstream.toml",
        "limits.toml",
        "openai.toml",
        "openrouter.toml",
        "anthropic.toml",
        "llm.toml",
        "decision.toml",
        "history.toml",
        "autoroute.toml",
    ] {
        std::fs::copy(format!("config/{name}"), dir.join(name)).unwrap();
    }
    std::fs::write(
        dir.join("prices.toml"),
        r#"
[prices."mistralai/devstral-2512"]
input = 1.0
"#,
    )
    .unwrap();
    let config = Config::load_from_directory(&dir).unwrap();
    let price = config.prices.get("mistralai/devstral-2512").unwrap();
    assert!(!price.rates_complete);
    assert_eq!(price.input, 1.0);
    let usage = usage_from_output(concat!(
        r#"{"usage":{"input_tokens":1000000,"output_tokens":0,"cache_read_input_tokens":0,"#,
        r#""cost":0,"is_byok":true,"cost_details":{"upstream_inference_cost":0.01}}}"#
    ));
    let resolved = resolve_cost(&usage, Some("mistralai/devstral-2512"), &config.prices);
    assert_eq!(resolved.source, CostSource::Upstream);
    assert_eq!(resolved.cost, Some(CostMicros(10_000)));
    assert!(resolved.estimated_cost.is_none());
    let _ = std::fs::remove_dir_all(&dir);
}
