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

fn provider_from_value(value: &Value) -> Option<ChatCompatProvider> {
    value.as_str().and_then(parse_chat_provider_token)
}

fn invalid_string_selector(field: &'static str, value: &Value) -> Option<ProxyError> {
    let Value::String(raw) = value else {
        return None;
    };
    if parse_chat_provider_token(raw).is_some() {
        return None;
    }
    Some(ProxyError::InvalidProviderSelector {
        field,
        token: raw.clone(),
    })
}

fn body_hint_from_selectors(
    type_removed: &Option<Value>,
    octo_removed: &Option<Value>,
) -> Option<ChatCompatProvider> {
    if let Some(value) = type_removed {
        if let Some(provider) = provider_from_value(value) {
            return Some(provider);
        }
    }
    octo_removed.as_ref().and_then(provider_from_value)
}

fn validate_body_selectors(
    path_hint: Option<ChatCompatProvider>,
    type_removed: &Option<Value>,
    octo_removed: &Option<Value>,
    body_hint: Option<ChatCompatProvider>,
) -> Result<(), ProxyError> {
    if path_hint.is_some() || body_hint.is_some() {
        return Ok(());
    }
    if let Some(value) = type_removed {
        if let Some(err) = invalid_string_selector("type", value) {
            if octo_removed
                .as_ref()
                .and_then(provider_from_value)
                .is_some()
            {
                return Ok(());
            }
            return Err(err);
        }
    }
    if let Some(value) = octo_removed {
        if let Some(err) = invalid_string_selector("octo_provider", value) {
            return Err(err);
        }
    }
    Ok(())
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
        return Err(ProxyError::InvalidChatBody);
    };
    let Value::Object(mut map) = value else {
        return Ok((path_hint.unwrap_or(config_default), body.to_vec()));
    };

    let type_removed = map.remove("type");
    let octo_removed = map.remove("octo_provider");
    let out = serde_json::to_vec(&Value::Object(map)).unwrap_or_else(|_| body.to_vec());

    let body_hint = body_hint_from_selectors(&type_removed, &octo_removed);
    validate_body_selectors(path_hint, &type_removed, &octo_removed, body_hint)?;

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

    #[test]
    fn null_type_uses_default_provider() {
        let body = br#"{"type":null,"model":"x"}"#;
        let (provider, _) =
            resolve_chat_provider(None, body, ChatCompatProvider::OpenAi).unwrap();
        assert_eq!(provider, ChatCompatProvider::OpenAi);
    }

    #[test]
    fn invalid_type_falls_back_to_octo_provider() {
        let body = br#"{"type":"bogus","octo_provider":"OPENROUTER","model":"x"}"#;
        let (provider, _) =
            resolve_chat_provider(None, body, ChatCompatProvider::OpenAi).unwrap();
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
}
