mod support;

use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::{
    body::{to_bytes, Body},
    extract::Request,
    http::{header, Request as HttpRequest, StatusCode},
    routing::post,
    Router,
};
use octo::auto::Hints;
use octo::history::{ModelPrice, PriceTable};
use octo::routes;
use octo::state::AppState;
use serde_json::{json, Value};
use support::sample_config;
use tokio::net::TcpListener;
use tower::ServiceExt;

const EASY: &str = r#"{"is_hard":{"noul":0.1},"is_easy":{"noul":0.9}}"#;
const MEDIUM: &str = r#"{"is_hard":{"noul":0.1},"is_easy":{"noul":0.1}}"#;
const HARD: &str = r#"{"is_hard":{"noul":0.9},"is_easy":{"noul":0.1}}"#;
const HARD_COSTLY: &str = r#"{"is_hard":{"noul":0.9},"is_easy":{"noul":0.1},"usage":{"input_tokens":120,"output_tokens":8,"cost":0.003}}"#;

struct Classifier {
    addr: SocketAddr,
    hits: Arc<Mutex<Vec<Value>>>,
}

async fn spawn_classifier(reply: &'static str, status: u16, delay_ms: u64) -> Classifier {
    let hits = Arc::new(Mutex::new(Vec::<Value>::new()));
    let captured = hits.clone();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let app = Router::new().route(
        "/v1/decisions",
        post(move |request: Request| {
            let captured = captured.clone();
            async move {
                let bytes = to_bytes(request.into_body(), usize::MAX).await.unwrap();
                captured
                    .lock()
                    .unwrap()
                    .push(serde_json::from_slice(&bytes).unwrap_or(Value::Null));
                if delay_ms > 0 {
                    tokio::time::sleep(Duration::from_millis(delay_ms)).await;
                }
                (
                    StatusCode::from_u16(status).unwrap(),
                    [(header::CONTENT_TYPE, "application/json")],
                    reply,
                )
            }
        }),
    );
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    Classifier { addr, hits }
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

fn priced_config() -> octo::config::Config {
    let mut config = sample_config(256 * 1024);
    config.autoroute_low_model = "low-model".into();
    config.autoroute_mid_model = "mid-model".into();
    config.autoroute_high_model = "high-model".into();
    config.prices = PriceTable::new(vec![
        ("low-model".into(), price(0.1, 0.4)),
        ("mid-model".into(), price(1.0, 4.0)),
        ("high-model".into(), price(5.0, 20.0)),
    ]);
    config
}

fn state_with(classifier: &Classifier) -> AppState {
    let mut config = priced_config();
    config.openrouter_decisions_url = format!("http://{}/v1/decisions", classifier.addr);
    AppState::new(config).unwrap()
}

fn state_without_classifier() -> AppState {
    AppState::new(priced_config()).unwrap()
}

async fn call(
    state: &AppState,
    method: &str,
    uri: &str,
    headers: &[(&str, &str)],
    body: Vec<u8>,
) -> (StatusCode, Value) {
    let mut builder = HttpRequest::builder()
        .method(method)
        .uri(uri)
        .header(header::CONTENT_TYPE, "application/json");
    for (name, value) in headers {
        builder = builder.header(*name, *value);
    }
    let response = routes::router(state.clone())
        .oneshot(builder.body(Body::from(body)).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

async fn route_with(
    state: &AppState,
    body: &Value,
    headers: &[(&str, &str)],
) -> (StatusCode, Value) {
    call(
        state,
        "POST",
        "/autoroute/v1/route",
        headers,
        serde_json::to_vec(body).unwrap(),
    )
    .await
}

const AUTH: (&str, &str) = ("authorization", "Bearer sk-test");

async fn route(state: &AppState, body: &Value) -> (StatusCode, Value) {
    route_with(state, body, &[AUTH]).await
}

fn api(id: &str, tier: &str) -> Value {
    json!({"id": id, "kind": "api", "tier": tier})
}

fn agent(id: &str, extra: Value) -> Value {
    let mut value = json!({
        "id": id, "kind": "agent", "label": id, "flat_rate": true, "logged_in": true
    });
    for (key, field) in extra.as_object().unwrap() {
        value[key] = field.clone();
    }
    value
}

fn request(title: &str, candidates: Vec<Value>) -> Value {
    json!({
        "budget_key": "proj-1",
        "task": {"title": title, "brief": "look at it", "tools": ["Read", "Edit"], "depth": 1},
        "candidates": candidates
    })
}

fn ladder() -> Vec<Value> {
    vec![
        api("api-deep", "deep"),
        api("api-fast", "fast"),
        api("api-balanced", "balanced"),
    ]
}

#[tokio::test]
async fn health_advertises_route_api() {
    let state = state_without_classifier();
    let (status, value) = call(&state, "GET", "/health", &[], Vec::new()).await;
    assert_eq!(status, StatusCode::OK);
    assert!(value["capabilities"]
        .as_array()
        .unwrap()
        .contains(&json!("route_api")));
}

#[tokio::test]
async fn route_requires_the_client_key_like_other_autoroute_endpoints() {
    let mut config = priced_config();
    config.client_auth_key = "secret".to_string();
    let state = AppState::new(config).unwrap();
    let body = request("t", ladder());
    let (status, _) = route(&state, &body).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (status, value) = route_with(&state, &body, &[AUTH, ("x-octo-key", "secret")]).await;
    assert_eq!(status, StatusCode::OK, "{value}");
}

#[tokio::test]
async fn api_candidates_pick_the_cheapest_able_tier_for_each_band() {
    for (reply, band, choice, slug) in [
        (EASY, "easy", "api-fast", "low-model"),
        (MEDIUM, "medium", "api-balanced", "mid-model"),
        (HARD, "hard", "api-deep", "high-model"),
    ] {
        let classifier = spawn_classifier(reply, 200, 0).await;
        let state = state_with(&classifier);
        let (status, value) = route(&state, &request("do a thing", ladder())).await;
        assert_eq!(status, StatusCode::OK, "{value}");
        assert_eq!(value["band"], band);
        assert_eq!(value["choice"], choice);
        assert_eq!(value["model"], slug);
        assert!(value["reason"]
            .as_str()
            .unwrap()
            .to_lowercase()
            .contains(band));
        assert!(!value["reason"].as_str().unwrap().contains("not used"));
        assert!(value["request_id"].as_str().unwrap().starts_with("octo_"));
        assert_eq!(classifier.hits.lock().unwrap().len(), 1);
    }
}

#[tokio::test]
async fn estimates_use_the_price_table_with_a_nominal_request() {
    let classifier = spawn_classifier(EASY, 200, 0).await;
    let state = state_with(&classifier);
    let (_, value) = route(&state, &request("easy", ladder())).await;
    let low = 0.1 * 30_000.0 / 1e6 + 0.4 * 500.0 / 1e6;
    assert!((value["estimated_cost_usd"].as_f64().unwrap() - low).abs() < 1e-9);
    let alternatives = value["alternatives"].as_array().unwrap();
    let ids: Vec<&str> = alternatives
        .iter()
        .map(|a| a["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, ["api-balanced", "api-deep"], "cheapest first");
    let mid = 1.0 * 30_000.0 / 1e6 + 4.0 * 500.0 / 1e6;
    assert!((alternatives[0]["estimated_cost_usd"].as_f64().unwrap() - mid).abs() < 1e-9);
}

#[tokio::test]
async fn unpriced_models_estimate_null() {
    let classifier = spawn_classifier(EASY, 200, 0).await;
    let mut config = priced_config();
    config.prices = PriceTable::default();
    config.openrouter_decisions_url = format!("http://{}/v1/decisions", classifier.addr);
    let state = AppState::new(config).unwrap();
    let (status, value) = route(&state, &request("easy", ladder())).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        value["choice"], "api-fast",
        "unpriced ties fall back to the lower tier"
    );
    assert!(value["estimated_cost_usd"].is_null());
    assert!(value["alternatives"][0]["estimated_cost_usd"].is_null());
}

#[tokio::test]
async fn nominal_token_assumption_is_configurable() {
    let classifier = spawn_classifier(EASY, 200, 0).await;
    let mut config = priced_config();
    config.openrouter_decisions_url = format!("http://{}/v1/decisions", classifier.addr);
    config.autoroute_route.nominal_input_tokens = 1_000_000;
    config.autoroute_route.nominal_output_tokens = 0;
    let state = AppState::new(config).unwrap();
    let (_, value) = route(&state, &request("easy", ladder())).await;
    assert!((value["estimated_cost_usd"].as_f64().unwrap() - 0.1).abs() < 1e-9);
}

#[tokio::test]
async fn higher_tier_api_candidates_are_able_for_a_lower_band() {
    let classifier = spawn_classifier(EASY, 200, 0).await;
    let state = state_with(&classifier);
    let (_, value) = route(
        &state,
        &request(
            "easy",
            vec![api("only-deep", "deep"), api("only-balanced", "balanced")],
        ),
    )
    .await;
    assert_eq!(value["choice"], "only-balanced");
}

#[tokio::test]
async fn a_flat_rate_agent_beats_the_api() {
    let classifier = spawn_classifier(EASY, 200, 0).await;
    let state = state_with(&classifier);
    let mut candidates = ladder();
    candidates.push(agent("sub", json!({})));
    let (_, value) = route(&state, &request("easy", candidates)).await;
    assert_eq!(value["choice"], "sub");
    assert!(value.get("model").is_none());
    assert_eq!(value["estimated_cost_usd"], 0.0);
    let ids: Vec<&str> = value["alternatives"]
        .as_array()
        .unwrap()
        .iter()
        .map(|a| a["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, ["api-fast", "api-balanced", "api-deep"]);
    assert!(value["reason"].as_str().unwrap().contains("flat-rate"));
}

#[tokio::test]
async fn agents_rank_by_remaining_limit_unknown_counts_as_plenty_then_request_order() {
    let classifier = spawn_classifier(MEDIUM, 200, 0).await;
    let state = state_with(&classifier);
    let candidates = vec![
        agent("low-left", json!({"limit_remaining": 3})),
        agent("most-left", json!({"limit_remaining": 40})),
        agent("unknown-1", json!({})),
        agent("unknown-2", json!({"limit_remaining": null})),
    ];
    let (_, value) = route(&state, &request("medium", candidates)).await;
    assert_eq!(value["choice"], "unknown-1");
    let ids: Vec<&str> = value["alternatives"]
        .as_array()
        .unwrap()
        .iter()
        .map(|a| a["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, ["unknown-2", "most-left", "low-left"]);

    let candidates = vec![
        agent("low-left", json!({"limit_remaining": 3})),
        agent("most-left", json!({"limit_remaining": 40})),
        agent("tie", json!({"limit_remaining": 40})),
    ];
    let (_, value) = route(&state, &request("medium", candidates)).await;
    assert_eq!(value["choice"], "most-left", "ties by request order");
}

#[tokio::test]
async fn logged_out_and_exhausted_agents_are_never_chosen() {
    let classifier = spawn_classifier(EASY, 200, 0).await;
    let state = state_with(&classifier);
    let candidates = vec![
        agent("out", json!({"logged_in": false})),
        agent("empty", json!({"limit_remaining": 0})),
        api("api-fast", "fast"),
    ];
    let (_, value) = route(&state, &request("easy", candidates)).await;
    assert_eq!(value["choice"], "api-fast");
    assert!(value["alternatives"].as_array().unwrap().is_empty());
}

#[tokio::test]
async fn an_unusable_agent_is_not_chosen_even_as_the_last_resort() {
    let classifier = spawn_classifier(EASY, 200, 0).await;
    let state = state_with(&classifier);
    let candidates = vec![
        agent("out", json!({"logged_in": false})),
        agent("empty", json!({"limit_remaining": 0})),
        agent("ok", json!({"strengths": ["hard"]})),
    ];
    let (_, value) = route(&state, &request("easy", candidates)).await;
    assert_eq!(value["choice"], "ok", "fallback skips unusable agents");
    assert!(value["reason"]
        .as_str()
        .unwrap()
        .contains("first logged-in agent"));
}

#[tokio::test]
async fn an_agent_without_strengths_is_able_for_easy_and_medium_only() {
    for (reply, expected) in [(EASY, "sub"), (MEDIUM, "sub"), (HARD, "api-deep")] {
        let classifier = spawn_classifier(reply, 200, 0).await;
        let state = state_with(&classifier);
        let mut candidates = ladder();
        candidates.push(agent("sub", json!({})));
        let (_, value) = route(&state, &request("task", candidates)).await;
        assert_eq!(value["choice"], expected);
    }
}

#[tokio::test]
async fn prefer_flat_rate_for_hard_lets_an_agent_without_strengths_take_a_hard_task() {
    let classifier = spawn_classifier(HARD, 200, 0).await;
    let mut config = priced_config();
    config.openrouter_decisions_url = format!("http://{}/v1/decisions", classifier.addr);
    config.autoroute_route.prefer_flat_rate_for_hard = true;
    let state = AppState::new(config).unwrap();
    let mut candidates = ladder();
    candidates.push(agent("sub", json!({})));
    let (_, value) = route(&state, &request("task", candidates)).await;
    assert_eq!(value["choice"], "sub");
}

#[tokio::test]
async fn strengths_decide_which_bands_an_agent_can_take() {
    let classifier = spawn_classifier(HARD, 200, 0).await;
    let state = state_with(&classifier);
    let mut candidates = ladder();
    candidates.push(agent("strong", json!({"strengths": ["Hard", "easy"]})));
    let (_, value) = route(&state, &request("task", candidates)).await;
    assert_eq!(value["choice"], "strong", "strengths are case-insensitive");

    let classifier = spawn_classifier(MEDIUM, 200, 0).await;
    let state = state_with(&classifier);
    let mut candidates = ladder();
    candidates.push(agent("strong", json!({"strengths": ["hard", "easy"]})));
    let (_, value) = route(&state, &request("task", candidates)).await;
    assert_eq!(value["choice"], "api-balanced", "not listed for medium");

    let mut candidates = ladder();
    candidates.push(agent(
        "vague",
        json!({"strengths": ["rust", "refactoring"]}),
    ));
    let (_, value) = route(&state, &request("task", candidates)).await;
    assert_eq!(
        value["choice"], "vague",
        "unknown strength words count as no strengths: able for medium"
    );
}

#[tokio::test]
async fn a_paid_agent_ranks_after_the_api_tiers() {
    let classifier = spawn_classifier(EASY, 200, 0).await;
    let state = state_with(&classifier);
    let candidates = vec![
        agent("metered", json!({"flat_rate": false})),
        api("api-fast", "fast"),
    ];
    let (_, value) = route(&state, &request("task", candidates)).await;
    assert_eq!(value["choice"], "api-fast");
    assert_eq!(value["alternatives"][0]["id"], "metered");
    assert!(value["alternatives"][0]["estimated_cost_usd"].is_null());
}

#[tokio::test]
async fn nothing_able_returns_the_highest_api_tier_present() {
    let classifier = spawn_classifier(HARD, 200, 0).await;
    let state = state_with(&classifier);
    let candidates = vec![
        api("api-fast", "fast"),
        api("api-balanced", "balanced"),
        agent("sub", json!({"strengths": ["easy"]})),
    ];
    let (status, value) = route(&state, &request("task", candidates)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(value["band"], "hard");
    assert_eq!(value["choice"], "api-balanced");
    assert_eq!(value["model"], "mid-model");
    assert!(value["reason"]
        .as_str()
        .unwrap()
        .contains("highest API tier"));
}

#[tokio::test]
async fn nothing_able_without_api_returns_the_first_logged_in_agent() {
    let classifier = spawn_classifier(HARD, 200, 0).await;
    let state = state_with(&classifier);
    let candidates = vec![
        agent("out", json!({"logged_in": false})),
        agent("first", json!({})),
        agent("second", json!({"limit_remaining": 99})),
    ];
    let (status, value) = route(&state, &request("task", candidates)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(value["choice"], "first");
    assert!(value["reason"]
        .as_str()
        .unwrap()
        .contains("first logged-in agent"));
}

#[tokio::test]
async fn empty_and_all_unusable_candidates_are_422_in_the_anthropic_shape() {
    let classifier = spawn_classifier(EASY, 200, 0).await;
    let state = state_with(&classifier);
    for candidates in [
        vec![],
        vec![agent("out", json!({"logged_in": false}))],
        vec![
            agent("out", json!({"logged_in": false})),
            agent("empty", json!({"limit_remaining": 0})),
        ],
    ] {
        let (status, value) = route(&state, &request("task", candidates)).await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(value["type"], "error");
        assert_eq!(value["error"]["type"], "invalid_request_error");
        assert!(value["error"]["message"].as_str().unwrap().len() > 5);
    }
    assert!(
        classifier.hits.lock().unwrap().is_empty(),
        "no classifier call"
    );
}

#[tokio::test]
async fn bad_input_is_rejected_before_any_classifier_call() {
    let classifier = spawn_classifier(EASY, 200, 0).await;
    let state = state_with(&classifier);

    let (status, value) = call(
        &state,
        "POST",
        "/autoroute/v1/route",
        &[AUTH],
        b"not json".to_vec(),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(value["error"]["type"], "invalid_request_error");

    let mut missing = request("t", ladder());
    missing.as_object_mut().unwrap().remove("task");
    assert_eq!(route(&state, &missing).await.0, StatusCode::BAD_REQUEST);

    let mut unknown_tier = request("t", vec![api("x", "ultra")]);
    unknown_tier["candidates"][0]["tier"] = json!("ultra");
    assert_eq!(
        route(&state, &unknown_tier).await.0,
        StatusCode::BAD_REQUEST
    );

    let mut bad_key = request("t", ladder());
    bad_key["budget_key"] = json!("has space");
    assert_eq!(
        route(&state, &bad_key).await.0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    bad_key["budget_key"] = json!("");
    assert_eq!(
        route(&state, &bad_key).await.0,
        StatusCode::UNPROCESSABLE_ENTITY
    );

    let mut empty_task = request("", ladder());
    empty_task["task"]["brief"] = json!("  ");
    assert_eq!(
        route(&state, &empty_task).await.0,
        StatusCode::UNPROCESSABLE_ENTITY
    );

    let duplicated = request("t", vec![api("same", "fast"), api("same", "deep")]);
    assert_eq!(
        route(&state, &duplicated).await.0,
        StatusCode::UNPROCESSABLE_ENTITY
    );

    let blank_id = request("t", vec![api(" ", "fast")]);
    assert_eq!(
        route(&state, &blank_id).await.0,
        StatusCode::UNPROCESSABLE_ENTITY
    );

    assert!(classifier.hits.lock().unwrap().is_empty());
}

#[tokio::test]
async fn the_classifier_gets_title_brief_tool_names_and_a_capped_input() {
    let classifier = spawn_classifier(EASY, 200, 0).await;
    let state = state_with(&classifier);
    let mut body = request("Rename the field", ladder());
    body["task"]["brief"] = json!("x".repeat(10_000));
    let (status, _) = route(&state, &body).await;
    assert_eq!(status, StatusCode::OK);
    let hits = classifier.hits.lock().unwrap();
    assert_eq!(hits.len(), 1);
    let sent = &hits[0]["state"];
    let text = sent["user_text"].as_str().unwrap();
    assert!(text.starts_with("Rename the field\n\n"));
    assert!(text.chars().count() <= 2000, "capped like the proxy path");
    assert!(text.contains("chars omitted"));
    assert_eq!(sent["tools"], json!(["Read", "Edit"]));
    assert_eq!(hits[0]["model"], "typesafe/jev-1.13");
}

#[tokio::test]
async fn a_failed_classifier_falls_back_to_the_text_rule() {
    let state = state_without_classifier();
    let (status, value) = route(&state, &request("rename a variable", ladder())).await;
    assert_eq!(status, StatusCode::OK, "{value}");
    assert_eq!(value["band"], "easy");
    assert!(value["reason"]
        .as_str()
        .unwrap()
        .contains("classifier not used"));
    assert_eq!(value["choice"], "api-fast");

    let classifier = spawn_classifier("garbage", 200, 0).await;
    let state = state_with(&classifier);
    let (_, value) = route(&state, &request("rename a variable", ladder())).await;
    assert!(value["reason"]
        .as_str()
        .unwrap()
        .contains("classifier not used"));

    let classifier = spawn_classifier(EASY, 500, 0).await;
    let state = state_with(&classifier);
    let (status, value) = route(&state, &request("rename a variable", ladder())).await;
    assert_eq!(status, StatusCode::OK);
    assert!(value["reason"]
        .as_str()
        .unwrap()
        .contains("classifier not used"));
}

#[tokio::test]
async fn a_missing_api_key_skips_the_classifier() {
    let classifier = spawn_classifier(HARD, 200, 0).await;
    let state = state_with(&classifier);
    let (status, value) = route_with(&state, &request("task", ladder()), &[]).await;
    assert_eq!(status, StatusCode::OK);
    assert!(value["reason"].as_str().unwrap().contains("no API key"));
    assert!(classifier.hits.lock().unwrap().is_empty());
}

#[tokio::test]
async fn a_slow_classifier_times_out_and_the_request_still_succeeds() {
    let classifier = spawn_classifier(HARD, 200, 1500).await;
    let mut config = priced_config();
    config.openrouter_decisions_url = format!("http://{}/v1/decisions", classifier.addr);
    config.autoroute_route.classifier_timeout_ms = 80;
    let state = AppState::new(config).unwrap();
    let started = std::time::Instant::now();
    let (status, value) = route(&state, &request("do it", ladder())).await;
    assert_eq!(status, StatusCode::OK);
    assert!(started.elapsed() < Duration::from_millis(1000));
    assert!(value["reason"].as_str().unwrap().contains("timed out"));
    assert_eq!(classifier.hits.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn a_zero_timeout_disables_the_classifier() {
    let classifier = spawn_classifier(HARD, 200, 0).await;
    let mut config = priced_config();
    config.openrouter_decisions_url = format!("http://{}/v1/decisions", classifier.addr);
    config.autoroute_route.classifier_timeout_ms = 0;
    let state = AppState::new(config).unwrap();
    let (_, value) = route(&state, &request("do it", ladder())).await;
    assert!(value["reason"].as_str().unwrap().contains("disabled"));
    assert!(classifier.hits.lock().unwrap().is_empty());
}

#[tokio::test]
async fn the_fallback_band_follows_the_documented_text_rule() {
    let state = state_without_classifier();
    let band = |title: &str, brief: &str| {
        let state = state.clone();
        let mut body = request(title, ladder());
        body["task"]["brief"] = json!(brief);
        async move {
            route(&state, &body).await.1["band"]
                .as_str()
                .unwrap()
                .to_string()
        }
    };
    assert_eq!(band("Say hi", "").await, "easy");
    assert_eq!(band("Rename it", "A short note").await, "easy");
    assert_eq!(
        band("Read the repo", "inspect the files in src").await,
        "medium"
    );
    assert_eq!(
        band(
            "Crash",
            "Traceback (most recent call last): the stack trace points at foo"
        )
        .await,
        "hard"
    );
    assert_eq!(
        band(
            "Refactor",
            "Update src/a.rs and src/b.rs and make the tests pass"
        )
        .await,
        "hard",
        "several files plus tests"
    );
    assert_eq!(
        band("Refactor", "Update src/a.rs and src/b.rs").await,
        "medium"
    );
    assert_eq!(band("Long", &"word ".repeat(400)).await, "medium");
}

#[tokio::test]
async fn a_single_offered_tier_sets_the_fallback_band() {
    let state = state_without_classifier();
    let (_, value) = route(&state, &request("Say hi", vec![api("only", "deep")])).await;
    assert_eq!(value["band"], "hard");
    assert_eq!(value["choice"], "only");
}

#[tokio::test]
async fn the_decision_is_a_call_record_with_the_classifier_cost() {
    let classifier = spawn_classifier(HARD_COSTLY, 200, 0).await;
    let state = state_with(&classifier);
    let mut body = request("Fix the race", ladder());
    body["task"]["depth"] = json!(2);
    let (status, value) = route(&state, &body).await;
    assert_eq!(status, StatusCode::OK);
    let id = value["request_id"].as_str().unwrap();
    let (status, row) = call(
        &state,
        "GET",
        &format!("/autoroute/v1/calls/{id}"),
        &[],
        Vec::new(),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{row}");
    assert_eq!(row["trigger"], "route");
    assert_eq!(row["model"], "high-model");
    assert_eq!(row["tier"], "high");
    assert_eq!(row["input_tokens"], 120);
    assert_eq!(row["output_tokens"], 8);
    assert_eq!(row["cost_source"], "reported");
    assert!((row["cost_usd"].as_f64().unwrap() - 0.003).abs() < 1e-9);
    assert_eq!(row["route"]["choice"], "api-deep");
    assert_eq!(row["route"]["band"], "hard");
    assert_eq!(row["route"]["classifier"], "used");
    assert_eq!(row["route"]["depth"], 2);
    assert_eq!(row["route"]["budget_key"], "proj-1");
    assert_eq!(row["route"]["reason"], value["reason"]);
    assert_eq!(
        state.auto.budget_spent("proj-1"),
        3000,
        "spend counts on the key"
    );

    let (_, again) = route(&state, &body).await;
    assert_ne!(again["request_id"], value["request_id"]);
    assert_eq!(state.auto.budget_spent("proj-1"), 6000);
}

#[tokio::test]
async fn an_agent_decision_records_the_agent_id_and_a_fallback_costs_nothing() {
    let state = state_without_classifier();
    let (_, value) = route(&state, &request("Say hi", vec![agent("sub", json!({}))])).await;
    let id = value["request_id"].as_str().unwrap();
    let (_, row) = call(
        &state,
        "GET",
        &format!("/autoroute/v1/calls/{id}"),
        &[],
        Vec::new(),
    )
    .await;
    assert_eq!(row["trigger"], "route");
    assert_eq!(row["model"], "sub");
    assert_eq!(row["tier"], "agent");
    assert_eq!(row["cost_usd"], 0.0);
    assert_eq!(row["route"]["classifier"], "fallback");
}

#[tokio::test]
async fn a_reached_budget_skips_the_classifier_and_prefers_a_flat_rate_agent() {
    let classifier = spawn_classifier(HARD, 200, 0).await;
    let mut config = priced_config();
    config.openrouter_decisions_url = format!("http://{}/v1/decisions", classifier.addr);
    config.autoroute_session_budget_usd = 0.01;
    config.autoroute_session_budget_action = "reject".to_string();
    let state = AppState::new(config).unwrap();
    state.auto.add_cost(None, Some("proj-1"), 20_000);

    let mut candidates = ladder();
    candidates.push(agent("sub", json!({"strengths": ["easy"]})));
    candidates.push(agent("sub2", json!({"limit_remaining": 5})));
    let (status, value) = route(&state, &request("task", candidates)).await;
    assert_eq!(status, StatusCode::OK, "{value}");
    assert_eq!(
        value["choice"], "sub",
        "no hard-capable flat agent: first usable one"
    );
    assert!(value["reason"].as_str().unwrap().contains("Budget reached"));
    assert!(classifier.hits.lock().unwrap().is_empty());
    let id = value["request_id"].as_str().unwrap();
    let (_, row) = call(
        &state,
        "GET",
        &format!("/autoroute/v1/calls/{id}"),
        &[],
        Vec::new(),
    )
    .await;
    assert_eq!(row["route"]["classifier"], "skipped");

    let (status, value) = route(&state, &request("task", ladder())).await;
    assert_eq!(status, StatusCode::PAYMENT_REQUIRED);
    assert_eq!(value["error"]["type"], "billing_error");
    assert!(value["error"]["message"]
        .as_str()
        .unwrap()
        .contains("proj-1"));

    let mut other_key = request("task", ladder());
    other_key["budget_key"] = json!("proj-2");
    let (status, _) = route(&state, &other_key).await;
    assert_eq!(status, StatusCode::OK, "another key has its own spend");
}

#[tokio::test]
async fn a_downgrade_budget_routes_to_the_cheapest_api_tier_when_no_agent_is_free() {
    let classifier = spawn_classifier(HARD, 200, 0).await;
    let mut config = priced_config();
    config.openrouter_decisions_url = format!("http://{}/v1/decisions", classifier.addr);
    config.autoroute_session_budget_usd = 0.01;
    config.autoroute_session_budget_action = "downgrade".to_string();
    let state = AppState::new(config).unwrap();
    state.auto.add_cost(None, Some("proj-1"), 20_000);
    let (status, value) = route(&state, &request("task", ladder())).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(value["choice"], "api-fast");
    assert!(classifier.hits.lock().unwrap().is_empty());
}

#[tokio::test]
async fn a_harness_budget_always_rejects() {
    let state = {
        let mut config = priced_config();
        config.autoroute_session_budget_action = "downgrade".to_string();
        AppState::new(config).unwrap()
    };
    state.auto.bind_hints(
        None,
        &Hints {
            budget_key: Some("proj-1".into()),
            budget_micros: Some(10_000),
            ..Hints::default()
        },
    );
    state.auto.add_cost(None, Some("proj-1"), 10_000);
    let (status, _) = route(&state, &request("task", ladder())).await;
    assert_eq!(status, StatusCode::PAYMENT_REQUIRED);
    let mut with_agent = ladder();
    with_agent.push(agent("sub", json!({})));
    let (status, value) = route(&state, &request("task", with_agent)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(value["choice"], "sub");
}

#[tokio::test]
async fn route_sends_nothing_upstream_but_the_classifier() {
    let classifier = spawn_classifier(EASY, 200, 0).await;
    let state = state_with(&classifier);
    let (status, _) = route(&state, &request("task", ladder())).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(classifier.hits.lock().unwrap().len(), 1);
}

#[test]
fn route_policy_loads_from_the_route_table_and_the_shipped_config_matches_the_defaults() {
    let shipped =
        octo::config::Config::load_from_directory(std::path::Path::new("config")).unwrap();
    assert_eq!(shipped.autoroute_route, octo::auto::RoutePolicy::default());

    let dir = std::env::temp_dir().join(format!("octo-route-cfg-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    for entry in std::fs::read_dir("config").unwrap() {
        let path = entry.unwrap().path();
        if path.extension().is_some_and(|ext| ext == "toml") {
            std::fs::copy(&path, dir.join(path.file_name().unwrap())).unwrap();
        }
    }
    std::fs::write(
        dir.join("autoroute.toml"),
        "[autoroute.route]\nclassifier_timeout_ms = 750\nprefer_flat_rate_for_hard = true\nnominal_input_tokens = 1000\n",
    )
    .unwrap();
    let loaded = octo::config::Config::load_from_directory(&dir).unwrap();
    std::fs::remove_dir_all(&dir).ok();
    assert_eq!(loaded.autoroute_route.classifier_timeout_ms, 750);
    assert!(loaded.autoroute_route.prefer_flat_rate_for_hard);
    assert_eq!(loaded.autoroute_route.nominal_input_tokens, 1000);
    assert_eq!(loaded.autoroute_route.nominal_output_tokens, 500);
}

fn inverted_state(classifier: &Classifier, rule: bool) -> AppState {
    let mut config = priced_config();
    config.prices = PriceTable::new(vec![
        ("low-model".into(), price(9.0, 9.0)),
        ("mid-model".into(), price(5.0, 5.0)),
        ("high-model".into(), price(1.0, 1.0)),
    ]);
    config.autoroute_never_pay_more_for_less = rule;
    config.openrouter_decisions_url = format!("http://{}/v1/decisions", classifier.addr);
    AppState::new(config).unwrap()
}

#[tokio::test]
async fn the_price_rule_costs_each_api_candidate_at_what_would_really_be_served() {
    let classifier = spawn_classifier(EASY, 200, 0).await;
    let state = inverted_state(&classifier, true);
    let (status, value) = route(&state, &request("easy", ladder())).await;
    assert_eq!(status, StatusCode::OK, "{value}");
    let cheapest = 1.0 * 30_000.0 / 1e6 + 1.0 * 500.0 / 1e6;
    assert_eq!(
        value["choice"], "api-fast",
        "equal cost ties to the lower tier"
    );
    assert_eq!(value["model"], "high-model", "what the router would serve");
    assert!((value["estimated_cost_usd"].as_f64().unwrap() - cheapest).abs() < 1e-9);
    for alternative in value["alternatives"].as_array().unwrap() {
        assert!((alternative["estimated_cost_usd"].as_f64().unwrap() - cheapest).abs() < 1e-9);
    }
    let reason = value["reason"].as_str().unwrap();
    assert!(
        reason.contains("Price rule") && reason.contains("high-model"),
        "{reason}"
    );
    let id = value["request_id"].as_str().unwrap();
    let (_, row) = call(
        &state,
        "GET",
        &format!("/autoroute/v1/calls/{id}"),
        &[],
        Vec::new(),
    )
    .await;
    assert_eq!(row["model"], "high-model");
    assert_eq!(row["tier"], "high");
    assert_eq!(row["decided_tier"], "low");
}

#[tokio::test]
async fn the_price_rule_off_keeps_the_candidate_estimates_and_model() {
    let classifier = spawn_classifier(EASY, 200, 0).await;
    let state = inverted_state(&classifier, false);
    let (_, value) = route(&state, &request("easy", ladder())).await;
    assert_eq!(value["choice"], "api-deep", "cheapest by its own price");
    assert_eq!(value["model"], "high-model");
    assert!(!value["reason"].as_str().unwrap().contains("Price rule"));
    let low = 9.0 * 30_000.0 / 1e6 + 9.0 * 500.0 / 1e6;
    let alternatives = value["alternatives"].as_array().unwrap();
    let fast = alternatives.iter().find(|a| a["id"] == "api-fast").unwrap();
    assert!((fast["estimated_cost_usd"].as_f64().unwrap() - low).abs() < 1e-9);
    let id = value["request_id"].as_str().unwrap();
    let (_, row) = call(
        &state,
        "GET",
        &format!("/autoroute/v1/calls/{id}"),
        &[],
        Vec::new(),
    )
    .await;
    assert!(row.get("decided_tier").is_none(), "{row}");
}

#[tokio::test]
async fn the_route_endpoint_only_swaps_to_tiers_the_caller_offered() {
    let classifier = spawn_classifier(EASY, 200, 0).await;
    let state = inverted_state(&classifier, true);
    // only `fast` offered: high is cheaper but not a candidate, so low is served and estimated
    let (_, value) = route(&state, &request("easy", vec![api("api-fast", "fast")])).await;
    assert_eq!(value["choice"], "api-fast");
    assert_eq!(value["model"], "low-model");
    assert!(!value["reason"].as_str().unwrap().contains("Price rule"));
    let id = value["request_id"].as_str().unwrap();
    let (_, row) = call(
        &state,
        "GET",
        &format!("/autoroute/v1/calls/{id}"),
        &[],
        Vec::new(),
    )
    .await;
    assert!(row.get("decided_tier").is_none(), "{row}");
    let low = 9.0 * 30_000.0 / 1e6 + 9.0 * 500.0 / 1e6;
    assert!((value["estimated_cost_usd"].as_f64().unwrap() - low).abs() < 1e-9);
    // fast + deep offered: the swap to deep is allowed
    let offered = vec![api("api-fast", "fast"), api("api-deep", "deep")];
    let (_, value) = route(&state, &request("easy", offered)).await;
    assert_eq!(value["model"], "high-model");
}

#[tokio::test]
async fn unpriced_ladder_models_are_never_swapped_by_the_route_endpoint() {
    let classifier = spawn_classifier(EASY, 200, 0).await;
    let mut config = priced_config();
    config.prices = PriceTable::default();
    config.openrouter_decisions_url = format!("http://{}/v1/decisions", classifier.addr);
    let state = AppState::new(config).unwrap();
    let (_, value) = route(&state, &request("easy", ladder())).await;
    assert_eq!(value["model"], "low-model");
    assert!(!value["reason"].as_str().unwrap().contains("Price rule"));
}
