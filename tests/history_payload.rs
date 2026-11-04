use octo::history::{describe_input, usage_from_output, History};

#[tokio::test]
async fn same_secret_matches_and_raw_secret_is_not_the_hash() {
    let history = History::connect("sqlite::memory:", "server-key", 64)
        .await
        .unwrap();
    let left = history.token_hash("sk-user");
    let right = history.token_hash("sk-user");
    assert_eq!(left, right);
    assert_ne!(history.token_hash("sk-other"), left);
    assert!(!left.contains("sk-user"));
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
    let (input, output_tokens, cost) = usage_from_output(output);
    assert_eq!(input, Some(3));
    assert_eq!(output_tokens, Some(4));
    assert_eq!(cost, Some(0.25));
}

#[test]
fn usage_reads_anthropic_message_events() {
    let output = "data: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":11,\"output_tokens\":1}}}\n\ndata: {\"type\":\"message_delta\",\"usage\":{\"output_tokens\":9}}\n";
    let (input, output_tokens, cost) = usage_from_output(output);
    assert_eq!(input, Some(11));
    assert_eq!(output_tokens, Some(9));
    assert_eq!(cost, None);
}
