mod support;

use std::path::PathBuf;
use std::time::Duration;

use axum::{
    body::{to_bytes, Body},
    http::{header, Request, StatusCode},
    response::Response,
};
use octo::auto::{CallRow, RouteRecord};
use octo::history::{History, ModelPrice, PriceTable, Retention};
use octo::routes;
use octo::state::AppState;
use serde_json::{json, Value};
use sqlx::Row;
use support::{sample_config, spawn_scripted_server, Scripted};
use tower::ServiceExt;

const COSTLY: &str = r#"{"type":"message","role":"assistant","content":[],"usage":{"input_tokens":10,"output_tokens":5,"cost":2.0}}"#;
const PLAIN: &str = r#"{"type":"message","role":"assistant","content":[],"usage":{"input_tokens":1000,"output_tokens":500}}"#;
const HARD_COSTLY: &str = r#"{"is_hard":{"noul":0.9},"is_easy":{"noul":0.1},"usage":{"input_tokens":120,"output_tokens":8,"cost":0.003}}"#;
const FIXED: [(&str, &str); 2] = [
    ("x-octo-tier-hint", "fast"),
    ("x-octo-tier-policy", "fixed"),
];

fn temp_db(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "octo-call-persistence-{name}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir.join("history.sqlite")
}

fn price() -> ModelPrice {
    ModelPrice {
        input: 1.0,
        cache_read: 0.0,
        cache_write: 0.0,
        output: 2.0,
        billed_as: None,
        rates_complete: true,
    }
}

async fn boot(database: &str, messages: &str, decisions: &str, store_payloads: bool) -> AppState {
    let mut config = sample_config(256 * 1024);
    config.openrouter_messages_url = messages.to_string();
    config.openrouter_decisions_url = decisions.to_string();
    config.llm_messages_backend = "openrouter".to_string();
    config.autoroute_low_model = "low-model".into();
    config.autoroute_mid_model = "mid-model".into();
    config.autoroute_high_model = "high-model".into();
    let mut state = AppState::new(config).unwrap();
    state.history = History::connect(database, "test-key", 256 * 1024)
        .await
        .unwrap()
        .with_prices(PriceTable::new(vec![
            ("low-model".into(), price()),
            ("mid-model".into(), price()),
            ("high-model".into(), price()),
        ]))
        .with_store_payloads(store_payloads);
    state
}

const CLOSED: &str = "http://127.0.0.1:9/v1/messages";
const CLOSED_DECISIONS: &str = "http://127.0.0.1:9/v1/decisions";

async fn request(
    state: &AppState,
    method: &str,
    uri: &str,
    headers: &[(&str, &str)],
    body: &Value,
) -> Response {
    let mut builder = Request::builder()
        .method(method)
        .uri(uri)
        .header(header::CONTENT_TYPE, "application/json");
    for (name, value) in headers {
        builder = builder.header(*name, *value);
    }
    let body = if body.is_null() {
        Body::empty()
    } else {
        Body::from(serde_json::to_vec(body).unwrap())
    };
    routes::router(state.clone())
        .oneshot(builder.body(body).unwrap())
        .await
        .unwrap()
}

async fn finish(response: Response) -> (StatusCode, Response, Value) {
    let status = response.status();
    let (parts, body) = response.into_parts();
    let bytes = to_bytes(body, usize::MAX).await.unwrap();
    let value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    (status, Response::from_parts(parts, Body::empty()), value)
}

fn hv(response: &Response, name: &str) -> String {
    response
        .headers()
        .get(name)
        .unwrap_or_else(|| panic!("missing header {name}"))
        .to_str()
        .unwrap()
        .to_string()
}

fn turn(session: &str, text: &str) -> Value {
    json!({
        "model": "client-model",
        "max_tokens": 16,
        "metadata": {"user_id": format!("{{\"session_id\":\"{session}\"}}")},
        "messages": [{"role": "user", "content": text}]
    })
}

async fn send(
    state: &AppState,
    body: &Value,
    extra: &[(&str, &str)],
) -> (StatusCode, Response, Value) {
    let mut headers = vec![("authorization", "Bearer sk-test")];
    headers.extend_from_slice(extra);
    finish(request(state, "POST", "/autoroute/v1/messages", &headers, body).await).await
}

async fn fetch_call(state: &AppState, id: &str) -> (StatusCode, Value) {
    let (status, _, value) = finish(
        request(
            state,
            "GET",
            &format!("/autoroute/v1/calls/{id}"),
            &[],
            &Value::Null,
        )
        .await,
    )
    .await;
    (status, value)
}

fn budget_headers<'a>(key: &'a str, usd: &'a str) -> Vec<(&'a str, &'a str)> {
    let mut headers = FIXED.to_vec();
    headers.push(("x-octo-budget-key", key));
    headers.push(("x-octo-budget-usd", usd));
    headers
}

#[tokio::test]
async fn call_records_and_budget_spend_survive_a_restart() {
    let path = temp_db("restart");
    let database = path.to_str().unwrap();
    let (upstream, _) = spawn_scripted_server(
        "/v1/messages",
        vec![
            Scripted::ok().with_body(COSTLY),
            Scripted::ok().with_body(COSTLY),
        ],
    )
    .await;
    let url = format!("http://{upstream}/v1/messages");

    let first = boot(database, &url, CLOSED_DECISIONS, true).await;
    let headers = budget_headers("proj-restart", "3");
    let (status, response, _) = send(&first, &turn("agent-a", "hi"), &headers).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(hv(&response, "x-octo-spent-usd"), "0.000000");
    let first_id = hv(&response, "x-octo-request-id");
    first.history.drain().await;
    drop(first);

    let second = boot(database, &url, CLOSED_DECISIONS, true).await;
    let (status, row) = fetch_call(&second, &first_id).await;
    assert_eq!(status, StatusCode::OK, "record is read from the database");
    assert_eq!(row["model"], "low-model");
    assert_eq!(row["trigger"], "hint");
    assert_eq!(row["input_tokens"], 10);
    assert_eq!(row["cost_source"], "reported");
    assert!((row["cost_usd"].as_f64().unwrap() - 2.0).abs() < 1e-9);
    let (status, _) = fetch_call(&second, "octo_unknown").await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    let (status, response, _) = send(&second, &turn("agent-b", "hi"), &headers).await;
    assert_eq!(status, StatusCode::OK, "2.00 of 3.00 is still under budget");
    assert_eq!(
        hv(&response, "x-octo-spent-usd"),
        "2.000000",
        "spend was restored at the first use of the key"
    );
    second.history.drain().await;
    drop(second);

    let third = boot(database, &url, CLOSED_DECISIONS, true).await;
    let (status, response, value) = send(&third, &turn("agent-c", "hi"), &headers).await;
    assert_eq!(status, StatusCode::PAYMENT_REQUIRED);
    assert_eq!(hv(&response, "x-octo-spent-usd"), "4.000000");
    assert_eq!(value["error"]["type"], "billing_error");
    let (_, other, _) = send(
        &third,
        &turn("agent-d", "hi"),
        &budget_headers("proj-other", "3"),
    )
    .await;
    assert_eq!(
        hv(&other, "x-octo-spent-usd"),
        "0.000000",
        "other keys are not charged"
    );
    let _ = std::fs::remove_dir_all(path.parent().unwrap());
}

#[tokio::test]
async fn route_decision_and_its_classifier_cost_survive_a_restart() {
    let path = temp_db("route");
    let database = path.to_str().unwrap();
    let (classifier, _) =
        spawn_scripted_server("/v1/decisions", vec![Scripted::ok().with_body(HARD_COSTLY)]).await;
    let decisions = format!("http://{classifier}/v1/decisions");
    let first = boot(database, CLOSED, &decisions, true).await;
    let body = json!({
        "budget_key": "proj-route",
        "task": {"title": "Fix the race", "brief": "look at it", "tools": ["Read"], "depth": 2},
        "candidates": [
            {"id": "api-deep", "kind": "api", "tier": "deep"},
            {"id": "api-fast", "kind": "api", "tier": "fast"}
        ]
    });
    let (status, _, value) = finish(
        request(
            &first,
            "POST",
            "/autoroute/v1/route",
            &[("authorization", "Bearer sk-test")],
            &body,
        )
        .await,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{value}");
    let id = value["request_id"].as_str().unwrap().to_string();
    first.history.drain().await;
    drop(first);

    let second = boot(database, CLOSED, &decisions, true).await;
    let (status, row) = fetch_call(&second, &id).await;
    assert_eq!(status, StatusCode::OK, "{row}");
    assert_eq!(row["trigger"], "route");
    assert_eq!(row["route"]["choice"], "api-deep");
    assert_eq!(row["route"]["band"], "hard");
    assert_eq!(row["route"]["budget_key"], "proj-route");
    assert!((row["cost_usd"].as_f64().unwrap() - 0.003).abs() < 1e-9);

    let (upstream, _) = spawn_scripted_server("/v1/messages", vec![]).await;
    second.history.drain().await;
    drop(second);
    let third = boot(
        database,
        &format!("http://{upstream}/v1/messages"),
        CLOSED_DECISIONS,
        true,
    )
    .await;
    let headers = budget_headers("proj-route", "1");
    let (status, response, _) = send(&third, &turn("agent-r", "hi"), &headers).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(hv(&response, "x-octo-spent-usd"), "0.003000");
    let _ = std::fs::remove_dir_all(path.parent().unwrap());
}

#[tokio::test]
async fn proxied_history_row_carries_the_request_id() {
    let (upstream, _) =
        spawn_scripted_server("/v1/messages", vec![Scripted::ok().with_body(PLAIN)]).await;
    let state = boot(
        "sqlite::memory:",
        &format!("http://{upstream}/v1/messages"),
        CLOSED_DECISIONS,
        true,
    )
    .await;
    let (_, response, _) = send(&state, &turn("join-1", "hi"), &FIXED).await;
    let id = hv(&response, "x-octo-request-id");
    state.history.drain().await;
    let pool = state.history.pool().unwrap();
    let row = sqlx::query("SELECT request_id, model FROM calls WHERE request_id = ?")
        .bind(&id)
        .fetch_one(pool)
        .await
        .unwrap();
    assert_eq!(row.get::<String, _>("request_id"), id);
    assert_eq!(row.get::<String, _>("model"), "low-model");
    let record = sqlx::query("SELECT trigger FROM autoroute_calls WHERE request_id = ?")
        .bind(&id)
        .fetch_one(pool)
        .await
        .unwrap();
    assert_eq!(record.get::<String, _>("trigger"), "hint");
}

#[tokio::test]
async fn stored_call_records_hold_no_prompt_text_with_or_without_payloads() {
    for store_payloads in [true, false] {
        let (upstream, _) =
            spawn_scripted_server("/v1/messages", vec![Scripted::ok().with_body(PLAIN)]).await;
        let state = boot(
            "sqlite::memory:",
            &format!("http://{upstream}/v1/messages"),
            CLOSED_DECISIONS,
            store_payloads,
        )
        .await;
        let secret = "TOP-SECRET-PROMPT-TEXT";
        let (_, response, _) = send(
            &state,
            &turn("privacy", &format!("please do {secret}")),
            &FIXED,
        )
        .await;
        let id = hv(&response, "x-octo-request-id");
        state.history.drain().await;
        let pool = state.history.pool().unwrap();
        let row = sqlx::query("SELECT * FROM autoroute_calls WHERE request_id = ?")
            .bind(&id)
            .fetch_one(pool)
            .await
            .unwrap();
        let mut dump = String::new();
        for column in ["record", "model", "trigger", "session_id", "budget_key"] {
            dump.push_str(&row.try_get::<String, _>(column).unwrap_or_default());
        }
        assert!(!dump.contains(secret), "store_payloads={store_payloads}");
        let calls = sqlx::query("SELECT input FROM calls WHERE request_id = ?")
            .bind(&id)
            .fetch_one(pool)
            .await
            .unwrap();
        assert_eq!(
            calls.get::<String, _>("input").contains(secret),
            store_payloads,
            "the history row still follows store_payloads"
        );
    }
}

#[tokio::test]
async fn persisting_never_sits_on_the_response_path() {
    let (upstream, _) =
        spawn_scripted_server("/v1/messages", vec![Scripted::ok().with_body(PLAIN)]).await;
    let state = boot(
        "sqlite::memory:",
        &format!("http://{upstream}/v1/messages"),
        CLOSED_DECISIONS,
        true,
    )
    .await;
    let pool = state.history.pool().unwrap().clone();
    let held = [pool.acquire().await.unwrap(), pool.acquire().await.unwrap()];
    let body =
        json!({"model": "m", "max_tokens": 16, "messages": [{"role": "user", "content": "hi"}]});
    let (status, response, _) =
        tokio::time::timeout(Duration::from_secs(4), send(&state, &body, &FIXED))
            .await
            .expect(
                "a request that waited on the database would take the pool's 5 s acquire timeout",
            );
    assert_eq!(status, StatusCode::OK);
    let id = hv(&response, "x-octo-request-id");
    let (status, _) = fetch_call(&state, &id).await;
    assert_eq!(
        status,
        StatusCode::OK,
        "the in-memory cache answers at once"
    );
    drop(held);
    state.history.drain().await;
    let count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM autoroute_calls WHERE request_id = ?")
            .bind(&id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(count, 1, "written once the connections are free");
}

fn row(model: &str, cost_usd: f64) -> CallRow {
    CallRow {
        model: model.to_string(),
        tier: "low".to_string(),
        decided_tier: None,
        trigger: "none".to_string(),
        input_tokens: 1,
        output_tokens: 1,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        cost_usd,
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

async fn count(history: &History, table: &str) -> i64 {
    sqlx::query_scalar(&format!("SELECT COUNT(*) FROM {table}"))
        .fetch_one(history.pool().unwrap())
        .await
        .unwrap()
}

#[tokio::test]
async fn retention_prunes_by_row_count_age_and_idle_spend_in_batches() {
    let history = History::connect("sqlite::memory:", "k", 1024)
        .await
        .unwrap()
        .with_retention(Retention {
            calls_max_age: Some(Duration::from_secs(3600)),
            calls_max_rows: Some(100),
            spend_max_age: Some(Duration::from_secs(3600)),
        });
    for i in 0..1250 {
        history.record_call_row(&format!("octo_{i}"), None, None, &row("m", 0.5));
    }
    history.add_budget_spend("fresh".to_string(), 7);
    history.add_budget_spend("stale".to_string(), 9);
    history.drain().await;
    assert_eq!(count(&history, "autoroute_calls").await, 1250);

    let pool = history.pool().unwrap();
    sqlx::query("UPDATE budget_spend SET updated_at = 1 WHERE budget_key = 'stale'")
        .execute(pool)
        .await
        .unwrap();
    let stats = history.prune().await.unwrap();
    assert_eq!(stats.calls_by_rows, 1150);
    assert_eq!(stats.spend_rows, 1);
    assert_eq!(count(&history, "autoroute_calls").await, 100);
    assert!(
        history.call_record("octo_0").await.is_none(),
        "oldest go first"
    );
    assert!(history.call_record("octo_1249").await.is_some());
    assert_eq!(history.budget_spent_micros("fresh").await.unwrap(), Some(7));
    assert_eq!(history.budget_spent_micros("stale").await.unwrap(), None);

    sqlx::query("UPDATE autoroute_calls SET created_at = 1 WHERE seq % 2 = 0")
        .execute(pool)
        .await
        .unwrap();
    let stats = history.prune().await.unwrap();
    assert_eq!(stats.calls_by_age, 50);
    assert_eq!(count(&history, "autoroute_calls").await, 50);
    assert_eq!(
        history.prune().await.unwrap(),
        octo::history::PruneStats::default()
    );
}

#[tokio::test]
async fn pruning_leaves_the_history_table_and_unlimited_settings_alone() {
    let history = History::connect("sqlite::memory:", "k", 1024)
        .await
        .unwrap();
    for i in 0..5 {
        history.record_call_row(&format!("octo_{i}"), None, None, &row("m", 0.0));
    }
    history.drain().await;
    assert_eq!(history.prune().await.unwrap(), Default::default());
    assert_eq!(count(&history, "autoroute_calls").await, 5);
    assert!(history.spawn_pruner(Duration::from_secs(1)).is_none());
}

#[tokio::test]
async fn duplicate_request_ids_are_stored_once() {
    let history = History::connect("sqlite::memory:", "k", 1024)
        .await
        .unwrap();
    history.record_call_row("octo_dup", None, None, &row("first", 0.0));
    history.drain().await;
    history.record_call_row("octo_dup", None, None, &row("second", 0.0));
    history.drain().await;
    assert_eq!(count(&history, "autoroute_calls").await, 1);
    assert_eq!(
        history.call_record("octo_dup").await.unwrap()["model"],
        "first"
    );
}
