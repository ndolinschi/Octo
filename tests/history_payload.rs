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
