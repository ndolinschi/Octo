use octo::proxy::error::ProxyError;
use octo::proxy::select::{
    resolve_chat_provider, resolve_messages_provider, ChatCompatProvider, MessagesProvider,
};
use serde_json::Value;

#[test]
fn body_type_openrouter_stripped() {
    let body = br#"{"type":"OPENROUTER","model":"x","messages":[]}"#;
    let (provider, out) = resolve_chat_provider(None, body, ChatCompatProvider::OpenAi).unwrap();
    assert_eq!(provider, ChatCompatProvider::OpenRouter);
    let v: Value = serde_json::from_slice(&out).unwrap();
    assert!(v.get("type").is_none());
    assert_eq!(v["model"], "x");
}

#[test]
fn path_hint_overrides_body() {
    let body = br#"{"type":"OPENROUTER","model":"x"}"#;
    let (provider, _) = resolve_chat_provider(
        Some(ChatCompatProvider::OpenAi),
        body,
        ChatCompatProvider::OpenRouter,
    )
    .unwrap();
    assert_eq!(provider, ChatCompatProvider::OpenAi);
}

#[test]
fn default_is_config_backend() {
    let body = br#"{"model":"x"}"#;
    let (provider, _) = resolve_chat_provider(None, body, ChatCompatProvider::OpenAi).unwrap();
    assert_eq!(provider, ChatCompatProvider::OpenAi);
}

#[test]
fn invalid_type_returns_error_without_path_hint() {
    let body = br#"{"type":"not-a-provider","model":"x"}"#;
    assert!(matches!(
        resolve_chat_provider(None, body, ChatCompatProvider::OpenAi),
        Err(ProxyError::InvalidProviderSelector { field: "type", .. })
    ));
}

#[test]
fn path_hint_allows_invalid_body_type() {
    let body = br#"{"type":"not-a-provider","model":"x"}"#;
    let (provider, out) = resolve_chat_provider(
        Some(ChatCompatProvider::OpenRouter),
        body,
        ChatCompatProvider::OpenAi,
    )
    .unwrap();
    assert_eq!(provider, ChatCompatProvider::OpenRouter);
    let v: Value = serde_json::from_slice(&out).unwrap();
    assert!(v.get("type").is_none());
}

#[test]
fn null_type_uses_default_provider() {
    let body = br#"{"type":null,"model":"x"}"#;
    let (provider, _) = resolve_chat_provider(None, body, ChatCompatProvider::OpenAi).unwrap();
    assert_eq!(provider, ChatCompatProvider::OpenAi);
}

#[test]
fn invalid_type_falls_back_to_octo_provider() {
    let body = br#"{"type":"bogus","octo_provider":"OPENROUTER","model":"x"}"#;
    let (provider, _) = resolve_chat_provider(None, body, ChatCompatProvider::OpenAi).unwrap();
    assert_eq!(provider, ChatCompatProvider::OpenRouter);
}

#[test]
fn invalid_json_returns_error() {
    let body = br#"{"type":"OPENROUTER","model":"x""#;
    assert!(matches!(
        resolve_chat_provider(None, body, ChatCompatProvider::OpenAi),
        Err(ProxyError::InvalidChatBody)
    ));
}

#[test]
fn messages_body_type_openrouter_stripped() {
    let body = br#"{"type":"OPENROUTER","model":"anthropic/claude","max_tokens":1,"messages":[]}"#;
    let (provider, out) = resolve_messages_provider(None, body, MessagesProvider::Claude).unwrap();
    assert_eq!(provider, MessagesProvider::OpenRouter);
    let v: Value = serde_json::from_slice(&out).unwrap();
    assert!(v.get("type").is_none());
}

#[test]
fn messages_openrouter_folds_system_and_strips_model_marker() {
    let body = br#"{
        "type":"OPENROUTER",
        "model":"qwen/qwen3-coder-next[1m]",
        "messages":[
            {"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"ok"}]},
            {"role":"system","content":"Claude Code reminder"}
        ]
    }"#;
    let (provider, out) =
        resolve_messages_provider(None, body, MessagesProvider::OpenRouter).unwrap();
    assert_eq!(provider, MessagesProvider::OpenRouter);
    let v: Value = serde_json::from_slice(&out).unwrap();
    assert_eq!(v["model"], "qwen/qwen3-coder-next");
    assert_eq!(v["system"], "Claude Code reminder");
    assert!(v["messages"]
        .as_array()
        .unwrap()
        .iter()
        .all(|m| m["role"] != "system"));
}
