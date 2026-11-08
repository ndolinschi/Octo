mod support;

use octo::config::{Config, ConfigError};
use octo::providers::decision;
use octo::state::AppState;
use std::path::Path;
use support::sample_config;

#[test]
fn loads_split_config_directory() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("config");
    let config = Config::load_from_directory(&dir).unwrap();
    assert_eq!(config.bind_addr, "127.0.0.1:8080");
    assert_eq!(config.llm_chat_backend, "openai");
    assert_eq!(config.decision_backend, "openrouter");
    assert_eq!(
        config.openrouter_messages_url,
        "https://openrouter.ai/api/v1/messages"
    );
    assert_eq!(config.autoroute_low_model, "mistralai/ministral-8b-2512");
    assert_eq!(
        config.autoroute_mid_model,
        "mistralai/mistral-small-3.2-24b-instruct"
    );
    assert_eq!(config.autoroute_high_model, "mistralai/devstral-2512");
    assert_eq!(config.autoroute_hard_threshold, 0.5);
    assert_eq!(config.autoroute_easy_threshold, 0.5);
    assert_eq!(config.autoroute_stall_window, 6);
    assert_eq!(config.autoroute_escalate_turns, 3);
    assert_eq!(config.autoroute_down_confirm, 2);
    assert!(config.autoroute_high_allow.is_empty());
    assert_eq!(config.autoroute_provider_order, vec!["Mistral".to_string()]);
    assert_eq!(config.autoroute_session_budget_usd, 0.0);
    assert_eq!(
        config.autoroute_strip_fields,
        vec![
            "output_config".to_string(),
            "safeguards".to_string(),
            "context_management".to_string(),
        ]
    );
    assert_eq!(config.autoroute_require_parameters, "always");
}

#[test]
fn invalid_autoroute_require_parameters_fails_config_load() {
    let dir = std::env::temp_dir().join(format!(
        "octo-bad-require-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(
        dir.join("server.toml"),
        r#"
[server]
bind_addr = "127.0.0.1:8080"
"#,
    )
    .unwrap();
    std::fs::write(
        dir.join("limits.toml"),
        r#"
[limits]
max_body_bytes = 1000
"#,
    )
    .unwrap();
    std::fs::write(
        dir.join("autoroute.toml"),
        r#"
[autoroute]
require_parameters = "allways"
"#,
    )
    .unwrap();
    let err = Config::load_from_directory(&dir).unwrap_err();
    assert!(matches!(
        err,
        ConfigError::InvalidAutorouteRequireParameters { value } if value == "allways"
    ));
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn unknown_messages_backend_is_rejected() {
    let mut config = sample_config(1024);
    config.llm_messages_backend = "bedrock".to_string();
    assert!(AppState::new(config).is_err());
}

#[test]
fn unknown_decision_backend_is_rejected() {
    let mut config = sample_config(1024);
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
fn legacy_openrouter_table_parses_with_defaults() {
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

[openrouter]
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
        config.openai_chat_completions_url,
        "https://api.openai.com/v1/chat/completions"
    );
    assert_eq!(
        config.openrouter_decisions_url,
        "https://openrouter.ai/api/alpha/decisions"
    );
    assert!(decision::Providers::from_config(&config).is_ok());
}

#[test]
fn openai_section_loads_direct_api_url() {
    let path = std::env::temp_dir().join(format!(
        "octo-openai-{}.toml",
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
chat_completions_url = "https://api.openai.com/v1/chat/completions"

[openrouter]
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
    assert_eq!(
        config.openai_chat_completions_url,
        "https://api.openai.com/v1/chat/completions"
    );
}
