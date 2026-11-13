mod support;

use axum::{
    body::{to_bytes, Body},
    http::{header, Request, StatusCode},
};
use futures_util::StreamExt;
use octo::auto::{
    apply_sticky, cap_classifier_text, cap_for_budget, cap_for_budget_shaped, decide,
    ladder_warnings, shape, Auto, BudgetAction, Complexity, DecideRequest, RequestShape,
    SessionChoice, ShapePlan, StickyPlan, Tiers, Turn,
};
use octo::config::Config;
use octo::history::{
    complete_dropped_usage, usage_from_output, DroppedStream, History, ModelPrice, PriceTable,
    TokenCount,
};
use octo::providers::openrouter::{OpenRouterModel, OpenRouterModels};
use octo::routes;
use octo::state::AppState;
use serde_json::{json, Value};
use support::{sample_config, spawn_scripted_server, Scripted};
use tower::ServiceExt;

fn model(id: &str, window: u64, max_out: u64) -> OpenRouterModel {
    OpenRouterModel {
        id: id.into(),
        name: id.into(),
        is_free: false,
        context_length: Some(window),
        max_completion_tokens: Some(max_out),
        supported_parameters: vec!["max_tokens".into(), "tools".into()],
    }
}

fn catalog(window: u64, max_out: u64) -> OpenRouterModels {
    OpenRouterModels {
        free: vec![],
        paid: ["low-m", "mid-m", "high-m"]
            .into_iter()
            .map(|id| model(id, window, max_out))
            .collect(),
    }
}

fn tiers() -> Tiers {
    Tiers::new("low-m".into(), "mid-m".into(), "high-m".into())
}

fn price(input: f64, output: f64) -> ModelPrice {
    ModelPrice {
        input,
        cache_read: 0.0,
        cache_write: 0.0,
        output,
        billed_as: None,
        rates_complete: true,
    }
}

fn price_table(low: (f64, f64), mid: (f64, f64), high: (f64, f64)) -> PriceTable {
    PriceTable::new(vec![
        ("low-m".into(), price(low.0, low.1)),
        ("mid-m".into(), price(mid.0, mid.1)),
        ("high-m".into(), price(high.0, high.1)),
    ])
}

fn forward_of(turn: Turn) -> (String, String, Value) {
    let Turn::Forward(forward) = turn else {
        panic!("expected forward, got {turn:?}");
    };
    let value: Value = serde_json::from_slice(&forward.body).unwrap();
    (
        value["model"].as_str().unwrap_or_default().to_string(),
        forward.meta.trigger.clone(),
        value,
    )
}

struct Harness {
    history: History,
    client: reqwest::Client,
}

impl Harness {
    fn new() -> Self {
        Self {
            history: History::disabled(),
            client: reqwest::Client::new(),
        }
    }

    async fn decide(&self, auto: &Auto, body: Value, key: &str, decisions_url: &str) -> Turn {
        decide(DecideRequest {
            auto,
            history: &self.history,
            client: &self.client,
            decisions_url,
            api_key: key,
            body,
            allow_compact: true,
        })
        .await
    }
}

const DEAD_JEV: &str = "http://127.0.0.1:9/decisions";

fn session_meta(id: &str) -> Value {
    json!({"user_id": format!("{{\"session_id\":\"{id}\"}}")})
}

fn tool_loop(session: &str, big: usize, rounds: usize) -> Vec<Value> {
    let mut body = vec![json!({"role": "user", "content": "x".repeat(big)})];
    for i in 0..rounds {
        body.push(json!({"role": "assistant", "content": [{"type": "tool_use", "id": format!("t{i}"), "name": "Read", "input": {"n": i}}]}));
        body.push(json!({"role": "user", "content": [{"type": "tool_result", "tool_use_id": format!("t{i}"), "content": "ok"}]}));
    }
    let _ = session;
    body
}

fn tool_body(session: &str, messages: Vec<Value>) -> Value {
    json!({
        "model": "client-model",
        "max_tokens": 4096,
        "metadata": session_meta(session),
        "tools": [{"name": "Read"}],
        "messages": messages
    })
}

async fn compaction_auto(session: &str, cooldown: u32) -> Auto {
    let mut tiers = tiers();
    tiers.compact_cooldown_requests = cooldown;
    let auto = Auto::new(tiers);
    auto.seed_catalog(catalog(16_000, 4096)).await;
    auto.seed_session(
        session,
        SessionChoice::fresh("mid-m".into(), vec!["Read".into()], "mid".into()),
    );
    auto
}

#[tokio::test]
async fn r1_compaction_is_issued_once_when_client_does_not_shrink() {
    let harness = Harness::new();
    let auto = compaction_auto("g1", 0).await;
    let mut kinds = Vec::new();
    let mut triggers = Vec::new();
    for round in 1..=5 {
        let body = tool_body("g1", tool_loop("g1", 60_000, round));
        match harness.decide(&auto, body, "", DEAD_JEV).await {
            Turn::Compact(_) => kinds.push("compact"),
            Turn::Forward(forward) => {
                kinds.push("forward");
                triggers.push(forward.meta.trigger);
            }
            Turn::Reject(_) => panic!("unexpected reject"),
        }
    }
    assert_eq!(
        kinds,
        ["compact", "forward", "forward", "forward", "forward"]
    );
    assert_eq!(triggers[0], "compact_not_applied");
    assert!(triggers[1..].iter().all(|t| t != "compact_not_applied"));
    let row = auto.session_snapshot("g1").unwrap();
    assert!(row.compact_suppressed);
    assert!(!row.awaiting_compact);
}

#[tokio::test]
async fn r1_compaction_rearms_after_context_drops_below_threshold() {
    let harness = Harness::new();
    let auto = compaction_auto("g2", 0).await;
    let mut kinds = Vec::new();
    for round in 1..=3 {
        let body = tool_body("g2", tool_loop("g2", 60_000, round));
        kinds.push(match harness.decide(&auto, body, "", DEAD_JEV).await {
            Turn::Compact(_) => "compact",
            _ => "forward",
        });
    }
    assert_eq!(kinds, ["compact", "forward", "forward"]);
    let small = tool_body("g2", tool_loop("g2", 400, 1));
    let (_, _, _) = forward_of(harness.decide(&auto, small, "", DEAD_JEV).await);
    assert!(!auto.session_snapshot("g2").unwrap().compact_suppressed);
    let big = tool_body("g2", tool_loop("g2", 60_000, 4));
    let again = harness.decide(&auto, big, "", DEAD_JEV).await;
    assert!(
        matches!(again, Turn::Compact(_)),
        "second crossing compacts"
    );
}

#[tokio::test]
async fn r1_cooldown_requests_allow_another_compaction() {
    let harness = Harness::new();
    let auto = compaction_auto("g3", 2).await;
    let mut kinds = Vec::new();
    for round in 1..=5 {
        let body = tool_body("g3", tool_loop("g3", 60_000, round));
        kinds.push(match harness.decide(&auto, body, "", DEAD_JEV).await {
            Turn::Compact(_) => "compact",
            _ => "forward",
        });
    }
    assert_eq!(
        kinds,
        ["compact", "forward", "forward", "compact", "forward"]
    );
}

#[tokio::test]
async fn r1_client_that_applies_compaction_is_not_flagged() {
    let harness = Harness::new();
    let auto = compaction_auto("g4", 0).await;
    let first = tool_body("g4", tool_loop("g4", 60_000, 1));
    assert!(matches!(
        harness.decide(&auto, first, "", DEAD_JEV).await,
        Turn::Compact(_)
    ));
    let shrunk = tool_body("g4", tool_loop("g4", 400, 1));
    let (_, trigger, _) = forward_of(harness.decide(&auto, shrunk, "", DEAD_JEV).await);
    assert_ne!(trigger, "compact_not_applied");
    assert!(!auto.session_snapshot("g4").unwrap().compact_suppressed);
}

async fn jev_server(body: &str) -> (std::net::SocketAddr, support::CapturedRows) {
    spawn_scripted_server(
        "/decisions",
        vec![
            Scripted::ok().with_body(body),
            Scripted::ok().with_body(body),
            Scripted::ok().with_body(body),
        ],
    )
    .await
}

const JEV_HIGH: &str = r#"{"answers":{"is_hard":{"noul":0.9},"is_easy":{"noul":0.1}}}"#;

fn user_turn(session: &str, text: &str) -> Value {
    json!({
        "model": "client-model",
        "max_tokens": 1024,
        "metadata": session_meta(session),
        "tools": [{"name": "Read"}],
        "messages": [{"role": "user", "content": text}]
    })
}

fn tool_result_turn(session: &str) -> Value {
    json!({
        "model": "client-model",
        "max_tokens": 1024,
        "metadata": session_meta(session),
        "tools": [{"name": "Read"}],
        "messages": [
            {"role": "user", "content": "fix the bug"},
            {"role": "assistant", "content": [{"type": "tool_use", "id": "t1", "name": "Read", "input": {}}]},
            {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "t1", "content": "ok"}]}
        ]
    })
}

#[tokio::test]
async fn r2_classifier_failure_falls_back_to_mid_and_remembers_session() {
    let harness = Harness::new();
    let auto = Auto::new(tiers());
    auto.seed_catalog(catalog(1_000_000, 128_000)).await;
    let (model_1, trigger_1, _) = forward_of(
        harness
            .decide(&auto, user_turn("a1", "fix the bug"), "k", DEAD_JEV)
            .await,
    );
    assert_eq!(model_1, "mid-m");
    assert_eq!(trigger_1, "classifier_failure");
    let row = auto.session_snapshot("a1").expect("session remembered");
    assert_eq!(row.model, "mid-m");
    assert_eq!(row.sticky_band, "mid");
    let (model_2, _, _) = forward_of(
        harness
            .decide(&auto, tool_result_turn("a1"), "k", DEAD_JEV)
            .await,
    );
    assert_eq!(model_2, "mid-m", "tool loop stays on the fallback tier");
}

#[tokio::test]
async fn r2_classifier_failure_tier_is_configurable() {
    let harness = Harness::new();
    let mut tiers = tiers();
    tiers.classifier_failure_tier = "low".to_string();
    let auto = Auto::new(tiers);
    let (model, _, _) = forward_of(
        harness
            .decide(&auto, user_turn("a2", "fix the bug"), "k", DEAD_JEV)
            .await,
    );
    assert_eq!(model, "low-m");
    assert_eq!(auto.session_snapshot("a2").unwrap().sticky_band, "low");
}

#[tokio::test]
async fn r2_classification_is_retried_on_a_later_user_turn() {
    let harness = Harness::new();
    let auto = Auto::new(tiers());
    let (addr, rows) = jev_server(JEV_HIGH).await;
    let live = format!("http://{addr}/decisions");
    let (first, _, _) = forward_of(
        harness
            .decide(&auto, user_turn("a3", "fix the bug"), "k", DEAD_JEV)
            .await,
    );
    assert_eq!(first, "mid-m");
    assert_eq!(rows.lock().unwrap().len(), 0);
    let (second, trigger, _) = forward_of(
        harness
            .decide(
                &auto,
                user_turn("a3", "now redesign the whole module"),
                "k",
                &live,
            )
            .await,
    );
    assert_eq!(rows.lock().unwrap().len(), 1, "classifier called again");
    assert_eq!(second, "high-m");
    assert_eq!(trigger, "reclassify");
}

#[tokio::test]
async fn r2_missing_api_key_still_passes_through_unclassified() {
    let harness = Harness::new();
    let auto = Auto::new(tiers());
    let (model, trigger, _) = forward_of(
        harness
            .decide(&auto, user_turn("a4", "fix the bug"), "", DEAD_JEV)
            .await,
    );
    assert_eq!(model, "client-model");
    assert_eq!(trigger, "none");
    assert!(auto.session_snapshot("a4").is_none());
}

#[test]
fn r3_missing_max_tokens_uses_default_not_model_maximum() {
    let models = catalog(1_000_000, 128_000);
    let body = json!({"model": "x", "messages": [{"role": "user", "content": "hi"}]});
    let out = shape(ShapePlan::new(&body, "mid-m", None, Some(&models))).body;
    assert_eq!(out["max_tokens"], 8192);
}

#[test]
fn r3_default_is_configurable_and_capped_by_model_maximum() {
    let models = catalog(1_000_000, 4096);
    let body = json!({"model": "x", "messages": []});
    let mut plan = ShapePlan::new(&body, "mid-m", None, Some(&models));
    plan.default_max_tokens = 2048;
    assert_eq!(shape(plan).body["max_tokens"], 2048);
    let mut plan = ShapePlan::new(&body, "mid-m", None, Some(&models));
    plan.default_max_tokens = 50_000;
    assert_eq!(shape(plan).body["max_tokens"], 4096);
}

#[test]
fn r3_explicit_max_tokens_is_respected_and_still_capped() {
    let models = catalog(1_000_000, 128_000);
    let body = json!({"model": "x", "max_tokens": 100_000, "messages": []});
    let out = shape(ShapePlan::new(&body, "mid-m", None, Some(&models))).body;
    assert_eq!(out["max_tokens"], 100_000);
    let body = json!({"model": "x", "max_tokens": 900_000, "messages": []});
    let out = shape(ShapePlan::new(&body, "mid-m", None, Some(&models))).body;
    assert_eq!(out["max_tokens"], 128_000);
    let body = json!({"model": "x", "max_tokens": 64, "messages": []});
    let out = shape(ShapePlan::new(&body, "mid-m", None, Some(&models))).body;
    assert_eq!(out["max_tokens"], 64);
}

#[test]
fn r3_default_applies_without_catalogue_entry() {
    let body = json!({"model": "x", "messages": []});
    let out = shape(ShapePlan::new(&body, "unknown", None, None)).body;
    assert_eq!(out["max_tokens"], 8192);
}

#[tokio::test]
async fn r3_proxy_forwards_default_max_tokens_upstream() {
    let (addr, captured) = spawn_scripted_server("/v1/messages", vec![Scripted::ok()]).await;
    let mut config = upstream_config(addr);
    config.autoroute_default_max_tokens = 3000;
    let state = AppState::new(config).unwrap();
    let body = json!({"model": "low-model", "messages": [{"role": "user", "content": "hi"}]});
    let (status, _) = post_autoroute(state, body, &[]).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(captured.lock().unwrap()[0].json()["max_tokens"], 3000);
}

#[test]
fn r4_classifier_text_is_capped_with_head_tail_and_marker() {
    let short = "hello world";
    assert_eq!(cap_classifier_text(short), short);
    let text = format!("HEAD{}TAIL", "log line\n".repeat(50_000));
    let capped = cap_classifier_text(&text);
    assert!(capped.chars().count() <= 2000);
    assert!(capped.starts_with("HEAD"));
    assert!(capped.ends_with("TAIL"));
    assert!(capped.contains("chars omitted"));
    let unicode = "é".repeat(10_000);
    let capped = cap_classifier_text(&unicode);
    assert!(capped.chars().count() <= 2000);
    assert!(capped.contains("chars omitted"));
}

#[tokio::test]
async fn r4_classifier_request_does_not_scale_with_pasted_text() {
    let harness = Harness::new();
    let auto = Auto::new(tiers());
    let (addr, rows) = jev_server(JEV_HIGH).await;
    let live = format!("http://{addr}/decisions");
    let big = "please look at this log line\n".repeat(20_000);
    let _ = harness
        .decide(&auto, user_turn("f1", &big), "k", &live)
        .await;
    let small_text = "hi";
    let _ = harness
        .decide(&auto, user_turn("f2", small_text), "k", &live)
        .await;
    let rows = rows.lock().unwrap().clone();
    assert_eq!(rows.len(), 2);
    let (big_len, small_len) = (rows[0].body.len(), rows[1].body.len());
    assert!(
        big_len < small_len + 6_000,
        "classifier request grew from {small_len} to {big_len} bytes"
    );
}

#[test]
fn r6_over_budget_routes_to_cheapest_tier_by_price() {
    let mut tiers = tiers();
    tiers.session_budget_micros = 1_000_000;
    tiers.prices = price_table((0.30, 1.20), (0.15, 0.60), (0.006, 0.50));
    for classified in [Complexity::Low, Complexity::Mid, Complexity::High] {
        let mut sticky = apply_sticky(StickyPlan {
            tiers: &tiers,
            choice: None,
            classified,
            preferred: None,
            stall: None,
            tool_results_only: false,
        });
        cap_for_budget(&mut sticky, &tiers, 500_000_000);
        assert_eq!(sticky.model, "high-m", "{classified:?}");
        assert_eq!(sticky.sticky_band, "high");
        if classified != Complexity::High {
            assert_eq!(sticky.reason.as_deref(), Some("budget_cap"));
        }
    }
}

#[test]
fn r6_over_budget_picks_low_when_low_is_cheapest_and_keeps_cheapest_unchanged() {
    let mut tiers = tiers();
    tiers.session_budget_micros = 1_000_000;
    tiers.prices = price_table((0.05, 0.10), (0.15, 0.60), (3.0, 15.0));
    let mut sticky = apply_sticky(StickyPlan {
        tiers: &tiers,
        choice: None,
        classified: Complexity::High,
        preferred: None,
        stall: None,
        tool_results_only: false,
    });
    cap_for_budget(&mut sticky, &tiers, 2_000_000);
    assert_eq!(sticky.model, "low-m");
    let mut already = apply_sticky(StickyPlan {
        tiers: &tiers,
        choice: None,
        classified: Complexity::Low,
        preferred: None,
        stall: None,
        tool_results_only: false,
    });
    cap_for_budget(&mut already, &tiers, 2_000_000);
    assert_eq!(already.model, "low-m");
    assert_eq!(already.reason, None);
}

#[test]
fn r6_request_shape_decides_the_cheapest_tier() {
    let mut tiers = tiers();
    tiers.session_budget_micros = 1;
    tiers.prices = price_table((1.0, 1.0), (0.1, 10.0), (5.0, 5.0));
    let input_heavy = RequestShape {
        input_tokens: 100_000,
        output_tokens: 10,
    };
    let output_heavy = RequestShape {
        input_tokens: 10,
        output_tokens: 100_000,
    };
    assert_eq!(tiers.cheapest_band(input_heavy), Some("mid"));
    assert_eq!(tiers.cheapest_band(output_heavy), Some("low"));
    let mut sticky = apply_sticky(StickyPlan {
        tiers: &tiers,
        choice: None,
        classified: Complexity::High,
        preferred: None,
        stall: None,
        tool_results_only: false,
    });
    cap_for_budget_shaped(&mut sticky, &tiers, 10, output_heavy);
    assert_eq!(sticky.model, "low-m");
}

#[test]
fn r6_without_price_table_over_budget_keeps_legacy_mid_cap() {
    let mut tiers = tiers();
    tiers.session_budget_micros = 1_000_000;
    let mut sticky = apply_sticky(StickyPlan {
        tiers: &tiers,
        choice: None,
        classified: Complexity::High,
        preferred: None,
        stall: None,
        tool_results_only: false,
    });
    cap_for_budget(&mut sticky, &tiers, 2_000_000);
    assert_eq!(sticky.model, "mid-m");
}

#[tokio::test]
async fn r6_reject_action_returns_reject_turn_naming_budget_and_spend() {
    let harness = Harness::new();
    let mut tiers = tiers();
    tiers.session_budget_micros = 1_000_000;
    tiers.session_budget_action = BudgetAction::Reject;
    let auto = Auto::new(tiers);
    auto.seed_session(
        "b1",
        SessionChoice::fresh("high-m".into(), vec!["Read".into()], "high".into()),
    );
    auto.add_session_cost("b1", 1_234_567);
    let turn = harness
        .decide(&auto, tool_result_turn("b1"), "", DEAD_JEV)
        .await;
    let Turn::Reject(reject) = turn else {
        panic!("expected reject");
    };
    let message = reject.message();
    assert!(message.contains("$1.234567"), "{message}");
    assert!(message.contains("$1.000000"), "{message}");
    assert_eq!(reject.spent_micros, 1_234_567);
}

#[tokio::test]
async fn r6_downgrade_action_still_forwards_when_over_budget() {
    let harness = Harness::new();
    let mut tiers = tiers();
    tiers.session_budget_micros = 1_000_000;
    let auto = Auto::new(tiers);
    auto.seed_session(
        "b2",
        SessionChoice::fresh("high-m".into(), vec!["Read".into()], "high".into()),
    );
    auto.add_session_cost("b2", 5_000_000);
    let (model, trigger, _) = forward_of(
        harness
            .decide(&auto, tool_result_turn("b2"), "", DEAD_JEV)
            .await,
    );
    assert_eq!(model, "mid-m");
    assert_eq!(trigger, "budget_cap");
}

fn upstream_config(addr: std::net::SocketAddr) -> Config {
    let mut config = sample_config(64 * 1024);
    config.openrouter_messages_url = format!("http://{addr}/v1/messages");
    config.openrouter_decisions_url = format!("http://{addr}/v1/decisions");
    config.llm_messages_backend = "openrouter".to_string();
    config.autoroute_low_model = "low-model".into();
    config.autoroute_mid_model = "mid-model".into();
    config.autoroute_high_model = "high-model".into();
    config
}

async fn post_autoroute(
    state: AppState,
    body: Value,
    extra: &[(&str, &str)],
) -> (StatusCode, Vec<u8>) {
    let app = routes::router(state);
    let mut builder = Request::builder()
        .method("POST")
        .uri("/autoroute/v1/messages")
        .header(header::CONTENT_TYPE, "application/json");
    for (name, value) in extra {
        builder = builder.header(*name, *value);
    }
    let request = builder
        .body(Body::from(serde_json::to_vec(&body).unwrap()))
        .unwrap();
    let response = app.oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    (status, bytes.to_vec())
}

fn simple_turn(session: &str) -> Value {
    json!({
        "model": "low-model",
        "max_tokens": 16,
        "metadata": session_meta(session),
        "messages": [{"role": "user", "content": "hi"}]
    })
}

const COSTLY_OK: &str = r#"{"type":"message","role":"assistant","content":[],"usage":{"input_tokens":10,"output_tokens":5,"cost":2.0}}"#;

#[tokio::test]
async fn r6_reject_action_returns_402_in_anthropic_error_shape() {
    let (addr, captured) = spawn_scripted_server("/v1/messages", vec![Scripted::ok()]).await;
    let mut config = upstream_config(addr);
    config.autoroute_session_budget_usd = 1.0;
    config.autoroute_session_budget_action = "reject".to_string();
    let state = AppState::new(config).unwrap();
    state.auto.seed_session(
        "http-b1",
        SessionChoice::fresh("mid-model".into(), vec!["Bash".into()], "mid".into()),
    );
    state.auto.add_session_cost("http-b1", 3_500_000);
    let (status, bytes) = post_autoroute(state, simple_turn("http-b1"), &[]).await;
    assert_eq!(status, StatusCode::PAYMENT_REQUIRED);
    let value: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(value["type"], "error");
    assert_eq!(value["error"]["type"], "billing_error");
    let message = value["error"]["message"].as_str().unwrap();
    assert!(
        message.contains("$3.500000") && message.contains("$1.000000"),
        "{message}"
    );
    assert!(
        captured.lock().unwrap().is_empty(),
        "nothing reaches upstream"
    );
}

#[tokio::test]
async fn r6_budget_key_shares_one_budget_across_sessions_and_is_stripped() {
    let (addr, captured) = spawn_scripted_server(
        "/v1/messages",
        vec![Scripted::ok().with_body(COSTLY_OK), Scripted::ok()],
    )
    .await;
    let mut config = upstream_config(addr);
    config.autoroute_session_budget_usd = 1.0;
    config.autoroute_session_budget_action = "reject".to_string();
    let state = AppState::new(config).unwrap();
    let key = [("x-octo-budget-key", "project-7")];
    let (first, _) = post_autoroute(state.clone(), simple_turn("agent-a"), &key).await;
    assert_eq!(first, StatusCode::OK);
    assert_eq!(state.auto.session_cost_micros("agent-a"), 2_000_000);
    assert_eq!(
        state.auto.session_cost_micros("agent-b"),
        0,
        "unbound session has its own spend"
    );
    let (second, bytes) = post_autoroute(state.clone(), simple_turn("agent-b"), &key).await;
    assert_eq!(second, StatusCode::PAYMENT_REQUIRED);
    let value: Value = serde_json::from_slice(&bytes).unwrap();
    let message = value["error"]["message"].as_str().unwrap();
    assert!(
        message.contains("project-7") && message.contains("$2.000000"),
        "{message}"
    );
    let (third, _) = post_autoroute(state.clone(), simple_turn("agent-c"), &[]).await;
    assert_eq!(
        third,
        StatusCode::OK,
        "sessions without the key keep separate budgets"
    );
    let rows = captured.lock().unwrap().clone();
    assert_eq!(rows.len(), 2);
    for row in rows {
        assert!(
            row.header("x-octo-budget-key").is_none(),
            "header leaked upstream"
        );
    }
}

#[test]
fn r8_ladder_warnings_flag_inverted_and_unpriced_models() {
    let mut inverted = tiers();
    inverted.prices = price_table((0.051, 0.567), (0.15, 0.60), (0.006, 0.50));
    let warnings = ladder_warnings(&inverted);
    assert!(
        warnings
            .iter()
            .any(|w| w.contains("not monotonic") && w.contains("high-m")),
        "{warnings:?}"
    );

    let mut ordered = tiers();
    ordered.prices = price_table((0.05, 0.1), (0.15, 0.6), (3.0, 15.0));
    assert!(ladder_warnings(&ordered).is_empty());

    let mut missing = tiers();
    missing.prices = PriceTable::new(vec![("low-m".into(), price(0.05, 0.1))]);
    let warnings = ladder_warnings(&missing);
    assert!(warnings
        .iter()
        .any(|w| w.contains("mid-m") && w.contains("no usable price")));
    assert!(warnings
        .iter()
        .any(|w| w.contains("high-m") && w.contains("no usable price")));
}

#[test]
fn r8_shipped_config_prices_every_ladder_model() {
    let config = Config::load_from_directory(std::path::Path::new("config")).unwrap();
    let state = AppState::new(config).unwrap();
    let warnings = ladder_warnings(state.auto.tiers());
    assert!(
        warnings.iter().all(|w| !w.contains("no usable price")),
        "{warnings:?}"
    );
}

fn config_dir_with_autoroute(extra: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "octo-cost-fixes-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    for name in [
        "server.toml",
        "upstream.toml",
        "limits.toml",
        "openai.toml",
        "openrouter.toml",
        "anthropic.toml",
        "llm.toml",
        "decision.toml",
        "history.toml",
        "prices.toml",
    ] {
        std::fs::copy(format!("config/{name}"), dir.join(name)).unwrap();
    }
    std::fs::write(
        dir.join("autoroute.toml"),
        format!("[autoroute]\n{extra}\n"),
    )
    .unwrap();
    dir
}

#[test]
fn new_config_keys_default_and_validate() {
    let config = Config::load_from_directory(std::path::Path::new("config")).unwrap();
    assert_eq!(config.autoroute_classifier_failure_tier, "mid");
    assert_eq!(config.autoroute_default_max_tokens, 8192);
    assert_eq!(config.autoroute_retry_after_max_secs, 10);
    assert_eq!(config.autoroute_session_budget_action, "downgrade");
    assert_eq!(config.autoroute_compact_cooldown_requests, 0);
    assert_eq!(config.autoroute_session_budget_usd, 0.0);

    let dir = config_dir_with_autoroute(
        "classifier_failure_tier = \"low\"\nsession_budget_action = \"reject\"\ndefault_max_tokens = 2048\nretry_after_max_secs = 3\ncompact_cooldown_requests = 5",
    );
    let config = Config::load_from_directory(&dir).unwrap();
    assert_eq!(config.autoroute_classifier_failure_tier, "low");
    assert_eq!(config.autoroute_session_budget_action, "reject");
    assert_eq!(config.autoroute_default_max_tokens, 2048);
    assert_eq!(config.autoroute_retry_after_max_secs, 3);
    assert_eq!(config.autoroute_compact_cooldown_requests, 5);
    let state = AppState::new(config).unwrap();
    assert_eq!(
        state.auto.tiers().session_budget_action,
        BudgetAction::Reject
    );
    let _ = std::fs::remove_dir_all(&dir);

    for bad in [
        "classifier_failure_tier = \"top\"",
        "session_budget_action = \"explode\"",
        "default_max_tokens = 0",
    ] {
        let dir = config_dir_with_autoroute(bad);
        let err = Config::load_from_directory(&dir).unwrap_err().to_string();
        assert!(err.contains("autoroute."), "{bad}: {err}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}

#[test]
fn r7_dropped_messages_stream_keeps_input_and_estimates_output() {
    let text = "word ".repeat(400);
    let prefix = format!(
        "data: {{\"type\":\"message_start\",\"message\":{{\"usage\":{{\"input_tokens\":100,\"output_tokens\":1}}}}}}\n\ndata: {{\"type\":\"content_block_delta\",\"delta\":{{\"type\":\"text_delta\",\"text\":\"{text}\"}}}}\n\n"
    );
    let usage = usage_from_output(&prefix);
    assert_eq!(usage.output_tokens, Some(TokenCount(1)));
    let completed = complete_dropped_usage(
        usage,
        DroppedStream {
            request_bytes: 4_000,
            prefix: &prefix,
            tail: "",
            response_bytes: prefix.len(),
        },
    );
    assert_eq!(completed.input_tokens, Some(TokenCount(100)));
    let output = completed.output_tokens.unwrap().0;
    assert!((450..=550).contains(&output), "output estimate {output}");
}

#[test]
fn r7_dropped_chat_stream_without_usage_estimates_both_sides() {
    let text = "abcd".repeat(100);
    let prefix = format!("data: {{\"choices\":[{{\"delta\":{{\"content\":\"{text}\"}}}}]}}\n\n");
    let completed = complete_dropped_usage(
        usage_from_output(&prefix),
        DroppedStream {
            request_bytes: 8_000,
            prefix: &prefix,
            tail: "",
            response_bytes: prefix.len(),
        },
    );
    assert_eq!(completed.input_tokens, Some(TokenCount(2_000)));
    assert_eq!(completed.output_tokens, Some(TokenCount(100)));
}

#[tokio::test]
async fn r7_stream_dropped_mid_response_still_records_tokens_and_cost() {
    use axum::http::Request as HttpRequest;
    use octo::history::{CallKind, CallObserve, CallProvider};
    use octo::providers::utils::{forward_content_type, proxy_post};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let text = "word ".repeat(400);
    let partial = format!(
        "data: {{\"type\":\"message_start\",\"message\":{{\"usage\":{{\"input_tokens\":100,\"output_tokens\":1}}}}}}\n\ndata: {{\"type\":\"content_block_delta\",\"delta\":{{\"type\":\"text_delta\",\"text\":\"{text}\"}}}}\n\n"
    );
    let served = partial.clone();
    tokio::spawn(async move {
        let mut socket = listener.accept().await.unwrap().0;
        let mut buf = Vec::new();
        let mut tmp = [0_u8; 1024];
        loop {
            let n = socket.read(&mut tmp).await.unwrap();
            if n == 0 {
                break;
            }
            buf.extend_from_slice(&tmp[..n]);
            if buf.windows(4).any(|w| w == b"\r\n\r\n") {
                break;
            }
        }
        let head = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            served.len() + 5_000
        );
        socket.write_all(head.as_bytes()).await.unwrap();
        socket.write_all(served.as_bytes()).await.unwrap();
    });
    let prices = PriceTable::new(vec![("some/model".into(), price(1.0, 10.0))]);
    let history = History::connect("sqlite::memory:", "test-token-key", 1 << 20)
        .await
        .unwrap()
        .with_prices(prices);
    let client = reqwest::Client::builder().build().unwrap();
    let request = HttpRequest::builder()
        .method("POST")
        .uri("http://127.0.0.1:8080/v1/messages")
        .body(Body::from(r#"{"model":"some/model","messages":[]}"#))
        .unwrap();
    let response = proxy_post(
        &client,
        &format!("http://{addr}/messages"),
        4096,
        request,
        forward_content_type,
        Some(CallObserve {
            history: history.clone(),
            kind: CallKind::Messages,
            provider: CallProvider::OpenRouter,
            rerouting: 0,
            rerouting_reason: None,
            session_id: None,
            tier_before: None,
            tier_after: None,
            decided_tier: None,
            trigger: "none".to_string(),
            trimmed_from_tokens: None,
            client_model: None,
            client_has_thinking: None,
            client_tool_names: None,
            bg_signal: None,
            hk_text_signal: None,
            auto: None,
            on_response: None,
            request_id: None,
            budget_key: None,
        }),
    )
    .await
    .unwrap();
    let mut body = response.into_body().into_data_stream();
    while body.next().await.is_some() {}
    drop(body);
    let mut row = None;
    for _ in 0..50 {
        let found = sqlx::query("SELECT input_tokens, output_tokens, cost_micros FROM calls")
            .fetch_optional(history.pool().unwrap())
            .await
            .unwrap();
        if found.is_some() {
            row = found;
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    use sqlx::Row;
    let row = row.expect("call row");
    assert_eq!(row.get::<Option<i64>, _>("input_tokens"), Some(100));
    let output = row.get::<Option<i64>, _>("output_tokens").unwrap();
    assert!(output > 400, "output tokens {output}");
    assert!(row.get::<Option<i64>, _>("cost_micros").unwrap() > 0);
}

#[tokio::test]
async fn r7_spend_is_restored_from_history_without_a_budget() {
    use octo::history::{CallKind, CallProvider, CostMicros, FinishedCall, Millis};

    let history = History::connect("sqlite::memory:", "test-token-key", 4096)
        .await
        .unwrap();
    history.record(FinishedCall {
        kind: CallKind::Messages,
        provider: CallProvider::OpenRouter,
        model: Some("low-m".into()),
        token_hash: None,
        message: None,
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
        cost: Some(CostMicros(750_000)),
        or_cost: Some(CostMicros(750_000)),
        upstream_cost: None,
        estimated_cost: None,
        cost_source: "openrouter".into(),
        is_byok: None,
        upstream_provider: None,
        trimmed_from_tokens: None,
        client_model: None,
        client_has_thinking: None,
        client_tool_names: None,
        bg_signal: None,
        hk_text_signal: None,
        request_id: None,
        cache_read_tokens: None,
        cache_write_tokens: None,
        generation_id: None,
        rerouting: 0,
        rerouting_reason: None,
        session_id: Some("restored".into()),
        parent_session_id: None,
        tier_before: None,
        tier_after: None,
        trigger: "none".into(),
    });
    history.drain().await;
    let auto = Auto::new(tiers());
    assert_eq!(auto.tiers().session_budget_micros, 0);
    let client = reqwest::Client::new();
    let _ = decide(DecideRequest {
        auto: &auto,
        history: &history,
        client: &client,
        decisions_url: DEAD_JEV,
        api_key: "",
        body: tool_result_turn("restored"),
        allow_compact: true,
    })
    .await;
    assert_eq!(auto.session_cost_micros("restored"), 750_000);
    auto.add_session_cost("restored", 50_000);
    assert_eq!(auto.session_cost_micros("restored"), 800_000);
}
