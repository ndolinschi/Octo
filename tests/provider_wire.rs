use octo::config::{Config, ConfigError};
use octo::providers::{decision, llm};

fn sample_config() -> Config {
    Config {
        bind_addr: "127.0.0.1:8080".to_string(),
        allow_remote: false,
        upstream_connect_timeout_secs: 30,
        upstream_request_timeout_secs: 600,
        openrouter_chat_completions_url: "https://openrouter.ai/api/v1/chat/completions"
            .to_string(),
        openrouter_chat_completions_path: "/v1/chat/completions".to_string(),
        openrouter_decisions_url: "https://openrouter.ai/api/alpha/decisions".to_string(),
        openrouter_decisions_path: "/v1/decisions".to_string(),
        openrouter_http_referer: None,
        openrouter_title: None,
        anthropic_messages_url: "https://api.anthropic.com/v1/messages".to_string(),
        anthropic_api_version: "2023-06-01".to_string(),
        anthropic_messages_path: "/v1/messages".to_string(),
        max_body_bytes: 1024,
        llm_chat_backend: "openai".to_string(),
        llm_messages_backend: "claude".to_string(),
        decision_backend: "openrouter".to_string(),
    }
}

#[test]
fn unknown_llm_chat_backend_is_rejected() {
    let mut config = sample_config();
    config.llm_chat_backend = "direct-openai".to_string();
    assert!(matches!(
        llm::Providers::from_config(&config),
        Err(ConfigError::UnknownBackend {
            kind: "llm.chat",
            ..
        })
    ));
}

#[test]
fn unknown_decision_backend_is_rejected() {
    let mut config = sample_config();
    config.decision_backend = "openai".to_string();
    assert!(matches!(
        decision::Providers::from_config(&config),
        Err(ConfigError::UnknownBackend {
            kind: "decision",
            ..
        })
    ));
}

#[test]
fn legacy_openai_table_parses_with_defaults() {
    let path = std::env::temp_dir().join(format!(
        "octo-legacy-{}.toml",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::write(
        &path,
        r#"
[server]
bind_addr = "127.0.0.1:8080"

[limits]
max_body_bytes = 1000

[openai]
chat_completions_url = "https://openrouter.ai/api/v1/chat/completions"
chat_completions_path = "/v1/chat/completions"

[anthropic]
messages_url = "https://api.anthropic.com/v1/messages"
messages_path = "/v1/messages"
api_version = "2023-06-01"
"#,
    )
    .unwrap();
    let config = Config::load_from_path(&path).unwrap();
    let _ = std::fs::remove_file(&path);
    assert_eq!(config.llm_chat_backend, "openai");
    assert_eq!(config.decision_backend, "openrouter");
    assert_eq!(
        config.openrouter_decisions_url,
        "https://openrouter.ai/api/alpha/decisions"
    );
    assert!(llm::Providers::from_config(&config).is_ok());
    assert!(decision::Providers::from_config(&config).is_ok());
}
