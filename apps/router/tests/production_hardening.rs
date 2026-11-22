mod support;

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use axum::{
    body::{to_bytes, Body},
    http::{header, Request, StatusCode},
    routing::{get, post},
    Router,
};
use octo::auto::{CallRow, DecideRequest, Hints, RouteRecord};
use octo::config::{Config, ConfigError};
use octo::history::{
    CallKind, CallProvider, CostMicros, DecisionRow, DelegationInsert, FinishedCall, History,
    Millis, Retention,
};
use octo::providers::openrouter::{fetch_models_with_limit, FetchModelsError};
use octo::routes;
use octo::state::{AppState, AppStateError};
use serde_json::{json, Value};
use sqlx::Row;
use support::{sample_config, spawn_scripted_server, Scripted};
use tokio::net::TcpListener;
use tower::ServiceExt;

fn temp_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "octo-hardening-{tag}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn minimal_config_dir(tag: &str, extra_files: &[(&str, &str)]) -> PathBuf {
    let dir = temp_dir(tag);
    std::fs::write(
        dir.join("server.toml"),
        "[server]\nbind_addr = \"127.0.0.1:8080\"\n",
    )
    .unwrap();
    std::fs::write(
        dir.join("limits.toml"),
        "[limits]\nmax_body_bytes = 1048576\n",
    )
    .unwrap();
    for (name, contents) in extra_files {
        std::fs::write(dir.join(name), contents).unwrap();
    }
    dir
}

fn sample_call_row() -> CallRow {
    CallRow {
        model: "m".to_string(),
        tier: "low".to_string(),
        decided_tier: None,
        trigger: "none".to_string(),
        input_tokens: 1,
        output_tokens: 1,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        cost_usd: 0.1,
        cost_source: "reported",
        estimate_ratio: None,
        price_source: None,
        upstream_id: None,
        spent_after_usd: None,
        route: Some(RouteRecord {
            choice: "c".to_string(),
            band: "easy",
            reason: "r".to_string(),
            classifier: "used",
            depth: 0,
            budget_key: "k".to_string(),
            decided_by: Some("jev"),
            fallback_reason: None,
            attempt: None,
        }),
    }
}

fn sample_finished_call(session_id: &str) -> FinishedCall {
    FinishedCall {
        kind: CallKind::Messages,
        provider: CallProvider::OpenRouter,
        model: Some("m".into()),
        token_hash: None,
        message: Some("msg".into()),
        input: "in".into(),
        output: "out".into(),
        request_payload: "{}".into(),
        response_payload: "{}".into(),
        status: 200,
        latency_ms: Millis::new(1),
        request_bytes: 2,
        response_bytes: 3,
        input_tokens: None,
        output_tokens: None,
        cost: Some(CostMicros(10)),
        or_cost: None,
        upstream_cost: None,
        estimated_cost: None,
        cost_source: "reported".into(),
        is_byok: None,
        upstream_provider: None,
        trimmed_from_tokens: None,
        cache_read_tokens: None,
        cache_write_tokens: None,
        generation_id: None,
        rerouting: 0,
        rerouting_reason: None,
        session_id: Some(session_id.into()),
        parent_session_id: None,
        tier_before: None,
        tier_after: None,
        trigger: "classify".into(),
        client_model: None,
        client_has_thinking: None,
        client_tool_names: None,
        bg_signal: None,
        hk_text_signal: None,
        request_id: None,
    }
}

fn sample_decision(secret: &str) -> DecisionRow {
    DecisionRow {
        session_id: Some("sess-dec".into()),
        purpose: "classify".into(),
        model: "typesafe/jev-1.13".into(),
        status: 200,
        latency_ms: 12,
        user_text: format!("user prompt {secret}"),
        is_hard: Some(false),
        is_easy: Some(true),
        is_hard_score: Some(0.1),
        is_easy_score: Some(0.9),
        tools_enough: Some("yes".into()),
        complexity: Some("low"),
        choice_rule: "easy".into(),
        missing_tools: Some(String::new()),
        request_payload: format!("{{\"prompt\":\"{secret}\"}}"),
        response_payload: format!("{{\"reply\":\"{secret}\"}}"),
        cost: Some(CostMicros(55)),
        or_cost: Some(CostMicros(55)),
        upstream_cost: None,
        estimated_cost: None,
        cost_source: "openrouter".into(),
    }
}

fn sample_delegation(request_id: &str) -> DelegationInsert {
    DelegationInsert {
        request_id: request_id.to_string(),
        budget_key: "proj-1".to_string(),
        session_id: None,
        attempt: 1,
        escalated_from: None,
        title: "Task".to_string(),
        brief: "Brief".to_string(),
        text_features: json!({}),
        tools: vec!["Read".to_string()],
        depth: 0,
        parent_tier: None,
        candidates: json!([]),
        exclude: vec![],
        min_tier: None,
        choice: "api-fast".to_string(),
        choice_kind: "api",
        choice_tier: Some("fast".to_string()),
        model: Some("low-model".to_string()),
        served_tier: "low".to_string(),
        band: "easy".to_string(),
        reason: "ok".to_string(),
        classifier: "heuristic".to_string(),
        classifier_requested: "heuristic".to_string(),
        classifier_version: "1".to_string(),
        classifier_status: "used".to_string(),
        fallback_reason: None,
        probabilities: None,
        estimated_cost_micros: Some(100),
        classifier_cost_micros: 0,
    }
}

async fn count(history: &History, table: &str) -> i64 {
    sqlx::query_scalar(&format!("SELECT COUNT(*) FROM {table}"))
        .fetch_one(history.pool().unwrap())
        .await
        .unwrap()
}

// [P1-1] Bounded SQLite retention pruning across all history tables.
#[tokio::test]
async fn retention_prunes_all_history_tables_in_bounded_batches() {
    let history = History::connect("sqlite::memory:", "k", 1024)
        .await
        .unwrap()
        .with_retention(Retention {
            calls_max_age: Some(Duration::from_secs(3600)),
            calls_max_rows: Some(2),
            spend_max_age: Some(Duration::from_secs(3600)),
        });

    for i in 0..4 {
        history.record_call_row(&format!("req_{i}"), None, None, &sample_call_row());
        history.record(sample_finished_call(&format!("s_{i}")));
        history.record_decision(sample_decision("x"));
        history
            .persist_delegation(&sample_delegation(&format!("del_{i}")))
            .await;
        history
            .insert_outcome(&format!("del_{i}"), "r1", "completed", &json!({}))
            .await
            .unwrap();
    }
    history.add_budget_spend("stale".into(), 10);
    history.add_budget_spend("fresh".into(), 20);
    history.drain().await;

    let pool = history.pool().unwrap();
    sqlx::query(
        "INSERT INTO session_outcomes (session_id, updated_at, last_status) VALUES ('old_s', 1, 'passed'), ('new_s', ?, 'passed')",
    )
    .bind(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64,
    )
    .execute(pool)
    .await
    .unwrap();

    sqlx::query("UPDATE autoroute_calls SET created_at = 1 WHERE request_id = 'req_0'")
        .execute(pool)
        .await
        .unwrap();
    sqlx::query("UPDATE calls SET created_at = 1 WHERE id = 1")
        .execute(pool)
        .await
        .unwrap();
    sqlx::query("UPDATE decisions SET created_at = 1 WHERE id <= 2")
        .execute(pool)
        .await
        .unwrap();
    sqlx::query("UPDATE delegations SET created_at = 1 WHERE request_id IN ('del_0', 'del_1')")
        .execute(pool)
        .await
        .unwrap();
    sqlx::query(
        "UPDATE delegation_outcomes SET received_at = 1 WHERE request_id IN ('del_0', 'del_1')",
    )
    .execute(pool)
    .await
    .unwrap();
    sqlx::query("UPDATE budget_spend SET updated_at = 1 WHERE budget_key = 'stale'")
        .execute(pool)
        .await
        .unwrap();

    let stats = history.prune().await.unwrap();
    assert_eq!(stats.calls_by_age, 1);
    assert_eq!(stats.calls_by_rows, 1);
    assert_eq!(stats.history_calls_by_age, 1);
    assert_eq!(stats.history_calls_by_rows, 1);
    assert_eq!(stats.decisions_by_age, 2);
    assert_eq!(stats.session_outcomes_by_age, 1);
    assert_eq!(stats.delegations_by_age, 2);
    assert_eq!(stats.delegation_outcomes_by_age, 2);
    assert_eq!(stats.spend_rows, 1);

    assert_eq!(count(&history, "autoroute_calls").await, 2);
    assert_eq!(count(&history, "calls").await, 2);
    assert_eq!(count(&history, "decisions").await, 2);
    assert_eq!(count(&history, "session_outcomes").await, 1);
    assert_eq!(count(&history, "delegations").await, 2);
    assert_eq!(count(&history, "delegation_outcomes").await, 2);
    assert_eq!(count(&history, "budget_spend").await, 1);
}

// [P1-2] store_payloads defaults to false and redacts decisions table columns.
#[tokio::test]
async fn store_payloads_defaults_false_and_redacts_decisions() {
    let shipped = Config::load_from_directory(Path::new("config")).unwrap();
    assert!(
        !shipped.history_store_payloads,
        "shipped config/history.toml should default store_payloads to false"
    );

    let dir = minimal_config_dir("default-payloads", &[]);
    let minimal = Config::load_from_directory(&dir).unwrap();
    assert!(
        !minimal.history_store_payloads,
        "omitted [history] section should default store_payloads to false"
    );
    let _ = std::fs::remove_dir_all(&dir);

    let secret = "SECRET-DECISION-PROMPT-999";
    let history_off = History::connect("sqlite::memory:", "k", 1024)
        .await
        .unwrap()
        .with_store_payloads(false);
    history_off.record_decision(sample_decision(secret));
    history_off.drain().await;

    let row = sqlx::query(
        "SELECT user_text, request_payload, response_payload, complexity, cost_micros FROM decisions",
    )
    .fetch_one(history_off.pool().unwrap())
    .await
    .unwrap();
    assert_eq!(row.get::<String, _>("user_text"), "");
    assert_eq!(row.get::<String, _>("request_payload"), "");
    assert_eq!(row.get::<String, _>("response_payload"), "");
    assert_eq!(
        row.get::<Option<String>, _>("complexity").as_deref(),
        Some("low")
    );
    assert_eq!(row.get::<Option<i64>, _>("cost_micros"), Some(55));

    let history_on = History::connect("sqlite::memory:", "k", 1024)
        .await
        .unwrap()
        .with_store_payloads(true);
    history_on.record_decision(sample_decision(secret));
    history_on.drain().await;

    let row = sqlx::query("SELECT user_text, request_payload, response_payload FROM decisions")
        .fetch_one(history_on.pool().unwrap())
        .await
        .unwrap();
    assert!(row.get::<String, _>("user_text").contains(secret));
    assert!(row.get::<String, _>("request_payload").contains(secret));
    assert!(row.get::<String, _>("response_payload").contains(secret));
}

// [P1-3] Immediate /outcome after /autoroute/v1/route never races into 404.
#[tokio::test]
async fn route_persists_delegation_before_returning_so_immediate_outcome_never_404s() {
    let mut config = sample_config(256 * 1024);
    config.autoroute_delegation.classifier = "heuristic".to_string();
    let mut state = AppState::new(config).unwrap();
    state.history = History::connect("sqlite::memory:", "k", 256 * 1024)
        .await
        .unwrap()
        .with_store_payloads(false);

    let app = routes::router(state);
    for i in 0..10 {
        let route_body = json!({
            "budget_key": "proj-race",
            "task": {"title": format!("Task {i}"), "brief": "rename a symbol", "tools": ["Read"]},
            "candidates": [{"id": "api-fast", "kind": "api", "tier": "fast"}]
        });
        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/autoroute/v1/route")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(serde_json::to_vec(&route_body).unwrap()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let bytes = to_bytes(resp.into_body(), usize::MAX).await.unwrap();
        let routed: Value = serde_json::from_slice(&bytes).unwrap();
        let request_id = routed["request_id"].as_str().unwrap();

        // Immediately post outcome WITHOUT draining history.
        let outcome_body = json!({
            "report_id": format!("rep-{i}"),
            "event": "finished",
            "status": "completed"
        });
        let out_resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!("/autoroute/v1/route/{request_id}/outcome"))
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(serde_json::to_vec(&outcome_body).unwrap()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(
            out_resp.status(),
            StatusCode::OK,
            "immediate outcome report for {request_id} must not 404"
        );
    }
}

// [P1-4] Hung Decisions upstream times out quickly and falls back to classifier_failure_tier.
#[tokio::test]
async fn classifier_timeout_falls_back_to_classifier_failure_tier() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let slow_addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let app = Router::new().route(
            "/v1/decisions",
            post(|| async {
                tokio::time::sleep(Duration::from_secs(5)).await;
                StatusCode::OK
            }),
        );
        axum::serve(listener, app).await.unwrap();
    });

    let (messages_addr, captured) =
        spawn_scripted_server("/v1/messages", vec![Scripted::ok(), Scripted::ok()]).await;

    let mut config = sample_config(256 * 1024);
    config.openrouter_decisions_url = format!("http://{slow_addr}/v1/decisions");
    config.openrouter_messages_url = format!("http://{messages_addr}/v1/messages");
    config.llm_messages_backend = "openrouter".to_string();
    config.autoroute_low_model = "low-fallback".to_string();
    config.autoroute_mid_model = "mid-model".to_string();
    config.autoroute_high_model = "high-model".to_string();
    config.autoroute_classifier_failure_tier = "low".to_string();
    config.autoroute_classifier_timeout_ms = 100;

    let state = AppState::new(config).unwrap();
    let app = routes::router(state);
    let body = json!({
        "model": "client-model",
        "max_tokens": 32,
        "metadata": {"user_id": "{\"session_id\":\"timeout-sess\"}"},
        "messages": [{"role": "user", "content": "explain how rust traits work"}]
    });

    let started = Instant::now();
    let resp = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/autoroute/v1/messages")
                .header(header::CONTENT_TYPE, "application/json")
                .header(header::AUTHORIZATION, "Bearer sk-test")
                .body(Body::from(serde_json::to_vec(&body).unwrap()))
                .unwrap(),
        )
        .await
        .unwrap();
    let elapsed = started.elapsed();

    assert_eq!(resp.status(), StatusCode::OK);
    assert!(
        elapsed < Duration::from_secs(2),
        "classifier timeout should trigger in ~100ms, took {elapsed:?}"
    );
    let sent = captured.lock().unwrap();
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0].json()["model"], "low-fallback");
}

// [P1-5 + P2-3] fetch_models enforces byte limit and non-OpenRouter upstream skips auto-fetch.
#[tokio::test]
async fn fetch_models_enforces_byte_limit_and_skips_non_openrouter_autofetch() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let app = Router::new().route(
            "/models",
            get(|| async {
                let big = "a".repeat(2048);
                ([(header::CONTENT_TYPE, "application/json")], big)
            }),
        );
        axum::serve(listener, app).await.unwrap();
    });

    let client = reqwest::Client::new();
    let err = fetch_models_with_limit(&client, &format!("http://{addr}/models"), None, 512)
        .await
        .unwrap_err();
    assert!(
        matches!(err, FetchModelsError::TooLarge(512)),
        "expected TooLarge(512), got {err:?}"
    );

    // Non-OpenRouter decisions_url must not auto-fetch from openrouter.ai.
    let config = sample_config(256 * 1024);
    let state = AppState::new(config).unwrap();
    let _ = octo::auto::decide_with(
        DecideRequest {
            auto: &state.auto,
            history: &state.history,
            client: &state.client,
            decisions_url: "http://127.0.0.1:9/v1/decisions",
            api_key: "sk-never-leak",
            body: json!({"model": "m", "messages": [{"role": "user", "content": "hi"}]}),
            allow_compact: false,
        },
        &Hints::default(),
    )
    .await;
    assert!(state.auto.cached_models().await.is_none());
}

// [P2-1] Zero upstream timeouts are rejected by config load.
#[test]
fn config_rejects_zero_upstream_timeouts() {
    let dir1 = minimal_config_dir(
        "zero-connect",
        &[("upstream.toml", "[upstream]\nconnect_timeout_secs = 0\n")],
    );
    let err1 = Config::load_from_directory(&dir1).unwrap_err();
    assert!(
        matches!(
            err1,
            ConfigError::InvalidUpstreamTimeout {
                field: "connect_timeout_secs"
            }
        ),
        "unexpected error: {err1:?}"
    );
    let _ = std::fs::remove_dir_all(&dir1);

    let dir2 = minimal_config_dir(
        "zero-request",
        &[("upstream.toml", "[upstream]\nrequest_timeout_secs = 0\n")],
    );
    let err2 = Config::load_from_directory(&dir2).unwrap_err();
    assert!(
        matches!(
            err2,
            ConfigError::InvalidUpstreamTimeout {
                field: "request_timeout_secs"
            }
        ),
        "unexpected error: {err2:?}"
    );
    let _ = std::fs::remove_dir_all(&dir2);
}

// [P2-3] Oversized JEV Decisions body is rejected and falls back cleanly.
#[tokio::test]
async fn oversized_decision_response_falls_back_cleanly() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let big_addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let app = Router::new().route(
            "/v1/decisions",
            post(|| async {
                let big = "x".repeat(1024 * 1024 + 64);
                ([(header::CONTENT_TYPE, "application/json")], big)
            }),
        );
        axum::serve(listener, app).await.unwrap();
    });

    let (messages_addr, captured) =
        spawn_scripted_server("/v1/messages", vec![Scripted::ok()]).await;

    let mut config = sample_config(256 * 1024);
    config.openrouter_decisions_url = format!("http://{big_addr}/v1/decisions");
    config.openrouter_messages_url = format!("http://{messages_addr}/v1/messages");
    config.llm_messages_backend = "openrouter".to_string();
    config.autoroute_low_model = "low-fallback".to_string();
    config.autoroute_classifier_failure_tier = "low".to_string();

    let state = AppState::new(config).unwrap();
    let resp = routes::router(state)
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/autoroute/v1/messages")
                .header(header::CONTENT_TYPE, "application/json")
                .header(header::AUTHORIZATION, "Bearer sk-test")
                .body(Body::from(
                    serde_json::to_vec(&json!({
                        "model": "client-model",
                        "max_tokens": 32,
                        "messages": [{"role": "user", "content": "refactor the parser"}]
                    }))
                    .unwrap(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let sent = captured.lock().unwrap();
    assert_eq!(sent[0].json()["model"], "low-fallback");
}

// [P2-6] Classifier cost is charged to budget_key even when session_id is absent.
#[tokio::test]
async fn classifier_cost_charged_to_budget_key_without_session_id() {
    let (decisions_addr, _) = spawn_scripted_server(
        "/v1/decisions",
        vec![Scripted::ok().with_body(
            r#"{"is_hard":{"noul":0.1},"is_easy":{"noul":0.9},"usage":{"input_tokens":10,"output_tokens":5,"cost":0.005}}"#,
        )],
    )
    .await;
    let (messages_addr, _) = spawn_scripted_server(
        "/v1/messages",
        vec![Scripted::ok().with_body(
            r#"{"type":"message","role":"assistant","content":[],"usage":{"input_tokens":10,"output_tokens":5,"cost":0.002}}"#,
        )],
    )
    .await;

    let mut config = sample_config(256 * 1024);
    config.openrouter_decisions_url = format!("http://{decisions_addr}/v1/decisions");
    config.openrouter_messages_url = format!("http://{messages_addr}/v1/messages");
    config.llm_messages_backend = "openrouter".to_string();

    let state = AppState::new(config).unwrap();
    let resp = routes::router(state.clone())
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/autoroute/v1/messages")
                .header(header::CONTENT_TYPE, "application/json")
                .header(header::AUTHORIZATION, "Bearer sk-test")
                .header("x-octo-budget-key", "stateless-budget")
                .body(Body::from(
                    serde_json::to_vec(&json!({
                        "model": "client-model",
                        "max_tokens": 32,
                        "messages": [{"role": "user", "content": "hello world"}]
                    }))
                    .unwrap(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let _ = to_bytes(resp.into_body(), usize::MAX).await.unwrap();
    // 0.005 (classifier) + 0.002 (upstream) = 7000 micro-USD.
    assert_eq!(state.auto.budget_spent("stateless-budget"), 7_000);
}

// [P2-7] Route path validation rejects missing leading '/' and duplicates, and AppState::new returns Err instead of panicking.
#[test]
fn config_validates_route_paths_and_state_new_returns_err() {
    let dir1 = minimal_config_dir(
        "bad-route",
        &[(
            "openrouter.toml",
            "[openrouter]\nchat_completions_path = \"v1/chat\"\n",
        )],
    );
    let err1 = Config::load_from_directory(&dir1).unwrap_err();
    assert!(
        matches!(
            err1,
            ConfigError::InvalidRoutePath {
                field: "openrouter.chat_completions_path",
                ..
            }
        ),
        "unexpected error: {err1:?}"
    );
    let _ = std::fs::remove_dir_all(&dir1);

    let dir2 = minimal_config_dir(
        "dup-static-route",
        &[(
            "openrouter.toml",
            "[openrouter]\ndecisions_path = \"/health\"\n",
        )],
    );
    let err2 = Config::load_from_directory(&dir2).unwrap_err();
    assert!(
        matches!(err2, ConfigError::DuplicateRoutePath { ref path } if path == "/health"),
        "unexpected error: {err2:?}"
    );
    let _ = std::fs::remove_dir_all(&dir2);

    let dir3 = minimal_config_dir(
        "dup-configured-route",
        &[(
            "openrouter.toml",
            "[openrouter]\ndecisions_path = \"/v1/messages\"\n",
        )],
    );
    let err3 = Config::load_from_directory(&dir3).unwrap_err();
    assert!(
        matches!(err3, ConfigError::DuplicateRoutePath { ref path } if path == "/v1/messages"),
        "unexpected error: {err3:?}"
    );
    let _ = std::fs::remove_dir_all(&dir3);

    let mut cfg = sample_config(256 * 1024);
    cfg.autoroute_require_parameters = "bogus".to_string();
    assert!(matches!(
        AppState::new(cfg),
        Err(AppStateError::Config(
            ConfigError::InvalidAutorouteRequireParameters { .. }
        ))
    ));

    let mut cfg2 = sample_config(256 * 1024);
    cfg2.autoroute_delegation.classifier = "bogus".to_string();
    assert!(matches!(
        AppState::new(cfg2),
        Err(AppStateError::Config(
            ConfigError::InvalidDelegationClassifier { .. }
        ))
    ));
}
