use serde_json::Value;

use crate::proxy::error::ProxyError;

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

fn body_selector_error(
    type_removed: Option<Value>,
    octo_removed: Option<Value>,
) -> Option<ProxyError> {
    if let Some(value) = type_removed {
        return invalid_selector_value("type", &value);
    }
    if let Some(value) = octo_removed {
        return invalid_selector_value("octo_provider", &value);
    }
    None
}

fn invalid_selector_value(field: &'static str, value: &Value) -> Option<ProxyError> {
    let token = match value {
        Value::String(raw) => raw.clone(),
        other => other.to_string(),
    };
    if parse_chat_provider_token(&token).is_some() {
        return None;
    }
    Some(ProxyError::InvalidProviderSelector { field, token })
}

pub fn chat_compat_from_llm_backend(raw: &str) -> Option<ChatCompatProvider> {
    parse_chat_provider_token(raw)
}

pub fn resolve_chat_provider(
    path_hint: Option<ChatCompatProvider>,
    body: &[u8],
    config_default: ChatCompatProvider,
) -> Result<(ChatCompatProvider, Vec<u8>), ProxyError> {
    let Ok(value) = serde_json::from_slice::<Value>(body) else {
        return Ok((path_hint.unwrap_or(config_default), body.to_vec()));
    };
    let Value::Object(mut map) = value else {
        return Ok((path_hint.unwrap_or(config_default), body.to_vec()));
    };

    let type_removed = map.remove("type");
    let octo_removed = map.remove("octo_provider");
    let out = serde_json::to_vec(&Value::Object(map)).unwrap_or_else(|_| body.to_vec());

    let mut body_hint = None;
    if let Some(value) = type_removed.as_ref().or(octo_removed.as_ref()) {
        if let Some(token) = value.as_str() {
            body_hint = parse_chat_provider_token(token);
        }
    }

    if path_hint.is_none() {
        if let Some(err) = body_selector_error(type_removed, octo_removed) {
            return Err(err);
        }
    }

    let provider = path_hint
        .or(body_hint)
        .unwrap_or(config_default);
    Ok((provider, out))
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
        let (provider, _) =
            resolve_chat_provider(None, body, ChatCompatProvider::OpenAi).unwrap();
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
}
