use serde_json::Value;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ChatCompatProvider {
    OpenAi,
    OpenRouter,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MessagesProvider {
    Claude,
}

pub fn parse_chat_provider_token(raw: &str) -> Option<ChatCompatProvider> {
    match raw.trim().replace('-', "_").to_ascii_lowercase().as_str() {
        "open_ai" | "openai" => Some(ChatCompatProvider::OpenAi),
        "openrouter" | "open_router" => Some(ChatCompatProvider::OpenRouter),
        _ => None,
    }
}

pub fn strip_chat_provider_from_body(bytes: &[u8]) -> (Option<ChatCompatProvider>, Vec<u8>) {
    let Ok(value) = serde_json::from_slice::<Value>(bytes) else {
        return (None, bytes.to_vec());
    };
    let Value::Object(mut map) = value else {
        return (None, bytes.to_vec());
    };
    let type_removed = map.remove("type");
    let octo_removed = map.remove("octo_provider");
    let mut provider = None;
    if let Some(value) = type_removed.or(octo_removed) {
        if let Some(token) = value.as_str() {
            provider = parse_chat_provider_token(token);
        }
    }
    let out = serde_json::to_vec(&Value::Object(map)).unwrap_or_else(|_| bytes.to_vec());
    (provider, out)
}

pub fn chat_compat_from_llm_backend(raw: &str) -> Option<ChatCompatProvider> {
    parse_chat_provider_token(raw)
}

pub fn resolve_chat_provider(
    path_hint: Option<ChatCompatProvider>,
    body: &[u8],
    config_default: ChatCompatProvider,
) -> (ChatCompatProvider, Vec<u8>) {
    let (body_hint, stripped) = strip_chat_provider_from_body(body);
    let provider = path_hint
        .or(body_hint)
        .unwrap_or(config_default);
    (provider, stripped)
}

pub fn parse_messages_provider_token(raw: &str) -> Option<MessagesProvider> {
    match raw.trim().replace('-', "_").to_ascii_lowercase().as_str() {
        "claude" | "anthropic" => Some(MessagesProvider::Claude),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn body_type_openrouter_stripped() {
        let body = br#"{"type":"OPENROUTER","model":"x","messages":[]}"#;
        let (provider, out) = strip_chat_provider_from_body(body);
        assert_eq!(provider, Some(ChatCompatProvider::OpenRouter));
        let v: Value = serde_json::from_slice(&out).unwrap();
        assert!(v.get("type").is_none());
        assert_eq!(v["model"], "x");
    }

    #[test]
    fn path_hint_overrides_body() {
        let body = br#"{"type":"OPENROUTER","model":"x"}"#;
        let (provider, _) =
            resolve_chat_provider(Some(ChatCompatProvider::OpenAi), body, ChatCompatProvider::OpenRouter);
        assert_eq!(provider, ChatCompatProvider::OpenAi);
    }

    #[test]
    fn default_is_openai() {
        let body = br#"{"model":"x"}"#;
        let (provider, _) =
            resolve_chat_provider(None, body, ChatCompatProvider::OpenAi);
        assert_eq!(provider, ChatCompatProvider::OpenAi);
    }
}
