mod support;

use axum::{
    body::{to_bytes, Body},
    http::{header, Request, Response, StatusCode},
};
use octo::auto::{
    decide_with, ladder_warnings, Auto, DecideRequest, Hints, RequestShape, SessionChoice,
    TierPolicy, Tiers, Turn,
};
use octo::config::Config;
use octo::history::{History, ModelPrice, PriceTable};
use octo::providers::openrouter::{OpenRouterModel, OpenRouterModels};
use octo::routes;
use octo::state::AppState;
use serde_json::{json, Value};
use support::{sample_config, spawn_scripted_server, Captured, Scripted};
use tower::ServiceExt;

const JEV_LOW: &str = r#"{"is_hard":{"noul":0.1},"is_easy":{"noul":0.9}}"#;
const MODEL_UNAVAILABLE: &str =
    r#"{"error":{"message":"No available model provider meets your routing requirements"}}"#;

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

fn table(low: Option<f64>, mid: Option<f64>, high: Option<f64>) -> PriceTable {
    let rows: Vec<(String, ModelPrice)> = [("low", low), ("mid", mid), ("high", high)]
        .into_iter()
        .filter_map(|(name, cost)| Some((format!("{name}-model"), price(cost?, cost?))))
        .collect();
    PriceTable::new(rows)
}

fn tiers_with(low: Option<f64>, mid: Option<f64>, high: Option<f64>) -> Tiers {
    let mut tiers = Tiers::new("low-model".into(), "mid-model".into(), "high-model".into());
    tiers.prices = table(low, mid, high);
    tiers
}

fn shape() -> RequestShape {
    RequestShape::default()
}

// ---- Tiers::price_swap ----

#[test]
fn an_inverted_ladder_serves_every_lower_tier_at_the_cheapest_tier_above() {
    let tiers = tiers_with(Some(9.0), Some(5.0), Some(1.0));
    assert_eq!(tiers.price_swap("low", None, shape()), Some("high"));
    assert_eq!(tiers.price_swap("mid", None, shape()), Some("high"));
    assert_eq!(tiers.price_swap("high", None, shape()), None);
}

#[test]
fn a_normally_ordered_ladder_never_swaps() {
    let tiers = tiers_with(Some(1.0), Some(5.0), Some(9.0));
    for band in ["low", "mid", "high"] {
        assert_eq!(tiers.price_swap(band, None, shape()), None, "{band}");
    }
}

#[test]
fn the_cheapest_tier_above_wins_not_just_the_top_one() {
    let tiers = tiers_with(Some(9.0), Some(1.0), Some(5.0));
    assert_eq!(tiers.price_swap("low", None, shape()), Some("mid"));
    assert_eq!(tiers.price_swap("mid", None, shape()), None);
}

#[test]
fn ties_keep_the_lower_tier() {
    let equal = tiers_with(Some(3.0), Some(3.0), Some(3.0));
    for band in ["low", "mid", "high"] {
        assert_eq!(equal.price_swap(band, None, shape()), None, "{band}");
    }
    let tied_above = tiers_with(Some(9.0), Some(3.0), Some(3.0));
    assert_eq!(tied_above.price_swap("low", None, shape()), Some("mid"));
}

#[test]
fn an_unpriced_decided_tier_is_served_as_decided() {
    let tiers = tiers_with(None, Some(5.0), Some(1.0));
    assert_eq!(tiers.price_swap("low", None, shape()), None);
    assert_eq!(tiers.price_swap("mid", None, shape()), Some("high"));
    assert_eq!(
        tiers_with(None, None, None).price_swap("low", None, shape()),
        None
    );
}

#[test]
fn an_unpriced_tier_above_is_never_preferred() {
    let skip_mid = tiers_with(Some(9.0), None, Some(1.0));
    assert_eq!(skip_mid.price_swap("low", None, shape()), Some("high"));
    let skip_high = tiers_with(Some(9.0), Some(5.0), None);
    assert_eq!(skip_high.price_swap("low", None, shape()), Some("mid"));
    let nothing_above = tiers_with(Some(9.0), None, None);
    assert_eq!(nothing_above.price_swap("low", None, shape()), None);
}

#[test]
fn a_zero_rate_row_counts_as_unpriced() {
    let mut tiers = tiers_with(Some(9.0), Some(5.0), None);
    tiers.prices = PriceTable::new(vec![
        ("low-model".into(), price(9.0, 9.0)),
        ("mid-model".into(), price(5.0, 5.0)),
        ("high-model".into(), price(0.0, 0.0)),
    ]);
    assert_eq!(tiers.price_swap("low", None, shape()), Some("mid"));
}

#[test]
fn a_ceiling_limits_the_candidates() {
    let tiers = tiers_with(Some(9.0), Some(5.0), Some(1.0));
    assert_eq!(tiers.price_swap("low", Some("mid"), shape()), Some("mid"));
    assert_eq!(tiers.price_swap("low", Some("low"), shape()), None);
    assert_eq!(tiers.price_swap("low", Some("high"), shape()), Some("high"));
    assert_eq!(tiers.price_swap("high", Some("low"), shape()), None);
    assert_eq!(tiers.price_swap("mid", Some("low"), shape()), None);
}

#[test]
fn the_rule_can_be_switched_off() {
    let mut tiers = tiers_with(Some(9.0), Some(5.0), Some(1.0));
    tiers.never_pay_more_for_less = false;
    assert_eq!(tiers.price_swap("low", None, shape()), None);
}

#[test]
fn only_ladder_tiers_are_swapped() {
    let tiers = tiers_with(Some(9.0), Some(5.0), Some(1.0));
    assert_eq!(tiers.price_swap("custom", None, shape()), None);
    assert_eq!(tiers.price_swap("unset", None, shape()), None);
}

#[test]
fn the_request_shape_decides_the_comparison() {
    let mut tiers = tiers_with(None, None, None);
    tiers.prices = PriceTable::new(vec![
        ("low-model".into(), price(1.0, 100.0)),
        ("mid-model".into(), price(10.0, 1.0)),
        ("high-model".into(), price(50.0, 50.0)),
    ]);
    let input_heavy = RequestShape {
        input_tokens: 100_000,
        output_tokens: 10,
    };
    let output_heavy = RequestShape {
        input_tokens: 10,
        output_tokens: 100_000,
    };
    assert_eq!(tiers.price_swap("low", None, input_heavy), None);
    assert_eq!(tiers.price_swap("low", None, output_heavy), Some("mid"));
}

// ---- HTTP: headers, call record, every trigger ----

fn config_for(addr: std::net::SocketAddr, prices: PriceTable) -> Config {
    let mut config = sample_config(256 * 1024);
    config.openrouter_messages_url = format!("http://{addr}/v1/messages");
    config.llm_messages_backend = "openrouter".to_string();
    config.autoroute_low_model = "low-model".into();
    config.autoroute_mid_model = "mid-model".into();
    config.autoroute_high_model = "high-model".into();
    config.prices = prices;
    config
}

fn inverted() -> PriceTable {
    table(Some(9.0), Some(5.0), Some(1.0))
}

fn turn(session: &str) -> Value {
    json!({
        "model": "client-model",
        "max_tokens": 16,
        "tools": [{"name": "Read"}],
        "metadata": {"user_id": format!("{{\"session_id\":\"{session}\"}}")},
        "messages": [{"role": "user", "content": "hi"}]
    })
}

fn tool_result_turn(session: &str) -> Value {
    json!({
        "model": "client-model",
        "max_tokens": 16,
        "tools": [{"name": "Read"}],
        "metadata": {"user_id": format!("{{\"session_id\":\"{session}\"}}")},
        "messages": [{"role": "user", "content": [{"type": "tool_result", "tool_use_id": "1", "content": "ok"}]}]
    })
}

async fn send(state: &AppState, body: &Value, extra: &[(&str, &str)]) -> Response<Body> {
    let mut builder = Request::builder()
        .method("POST")
        .uri("/autoroute/v1/messages")
        .header(header::CONTENT_TYPE, "application/json");
    for (name, value) in extra {
        builder = builder.header(*name, *value);
    }
    routes::router(state.clone())
        .oneshot(
            builder
                .body(Body::from(serde_json::to_vec(body).unwrap()))
                .unwrap(),
        )
        .await
        .unwrap()
}

async fn drain(response: Response<Body>) {
    let _ = to_bytes(response.into_body(), usize::MAX).await.unwrap();
}

fn hv(response: &Response<Body>, name: &str) -> Option<String> {
    response
        .headers()
        .get(name)
        .map(|value| value.to_str().unwrap().to_string())
}

async fn call_row(state: &AppState, response: Response<Body>) -> Value {
    let id = hv(&response, "x-octo-request-id").unwrap();
    drain(response).await;
    let request = Request::builder()
        .uri(format!("/autoroute/v1/calls/{id}"))
        .body(Body::empty())
        .unwrap();
    let response = routes::router(state.clone())
        .oneshot(request)
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    serde_json::from_slice(&bytes).unwrap()
}

fn upstream_models(captured: &[Captured]) -> Vec<String> {
    captured
        .iter()
        .map(|row| row.json()["model"].as_str().unwrap_or_default().to_string())
        .collect()
}

async fn state_for(prices: PriceTable, script: Vec<Scripted>) -> (AppState, support::CapturedRows) {
    let (addr, captured) = spawn_scripted_server("/v1/messages", script).await;
    (AppState::new(config_for(addr, prices)).unwrap(), captured)
}

#[tokio::test]
async fn hint_path_serves_the_cheapest_tier_and_reports_the_swap() {
    let (state, captured) = state_for(inverted(), vec![Scripted::ok()]).await;
    let response = send(&state, &turn("hint-1"), &[("x-octo-tier-hint", "fast")]).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(hv(&response, "x-octo-model").as_deref(), Some("high-model"));
    assert_eq!(hv(&response, "x-octo-tier").as_deref(), Some("high"));
    assert_eq!(hv(&response, "x-octo-decided-tier").as_deref(), Some("low"));
    assert_eq!(hv(&response, "x-octo-price-swap").as_deref(), Some("1"));
    assert_eq!(hv(&response, "x-octo-trigger").as_deref(), Some("hint"));
    let row = call_row(&state, response).await;
    assert_eq!(row["model"], "high-model");
    assert_eq!(row["tier"], "high");
    assert_eq!(row["decided_tier"], "low");
    assert_eq!(upstream_models(&captured.lock().unwrap()), ["high-model"]);
    let remembered = state.auto.session_snapshot("hint-1").unwrap();
    assert_eq!(
        remembered.sticky_band, "low",
        "the session keeps the decided tier"
    );
    assert_eq!(remembered.model, "low-model");
}

#[tokio::test]
async fn no_swap_means_no_extra_headers_and_no_decided_tier_in_the_record() {
    let ordered = table(Some(1.0), Some(5.0), Some(9.0));
    let (state, captured) = state_for(ordered, vec![Scripted::ok()]).await;
    let response = send(&state, &turn("plain-1"), &[("x-octo-tier-hint", "fast")]).await;
    assert_eq!(hv(&response, "x-octo-model").as_deref(), Some("low-model"));
    assert_eq!(hv(&response, "x-octo-tier").as_deref(), Some("low"));
    assert!(hv(&response, "x-octo-decided-tier").is_none());
    assert!(hv(&response, "x-octo-price-swap").is_none());
    let row = call_row(&state, response).await;
    assert!(row.get("decided_tier").is_none(), "{row}");
    assert_eq!(upstream_models(&captured.lock().unwrap()), ["low-model"]);
}

#[tokio::test]
async fn classifier_and_sticky_hold_paths_keep_the_decided_tier_and_serve_the_cheapest() {
    let (decisions, _) = spawn_scripted_server(
        "/v1/decisions",
        vec![
            Scripted::ok().with_body(JEV_LOW),
            Scripted::ok().with_body(JEV_LOW),
        ],
    )
    .await;
    let (addr, captured) =
        spawn_scripted_server("/v1/messages", vec![Scripted::ok(), Scripted::ok()]).await;
    let mut config = config_for(addr, inverted());
    config.openrouter_decisions_url = format!("http://{decisions}/v1/decisions");
    let state = AppState::new(config).unwrap();
    state.auto.seed_catalog(OpenRouterModels::default()).await;
    let auth = [("authorization", "Bearer sk-test")];
    let first = send(&state, &turn("classify-1"), &auth).await;
    assert_eq!(hv(&first, "x-octo-trigger").as_deref(), Some("classify"));
    assert_eq!(hv(&first, "x-octo-model").as_deref(), Some("high-model"));
    assert_eq!(hv(&first, "x-octo-decided-tier").as_deref(), Some("low"));
    drain(first).await;
    let hold = send(&state, &tool_result_turn("classify-1"), &auth).await;
    assert_eq!(hv(&hold, "x-octo-model").as_deref(), Some("high-model"));
    assert_eq!(hv(&hold, "x-octo-decided-tier").as_deref(), Some("low"));
    assert_eq!(hv(&hold, "x-octo-price-swap").as_deref(), Some("1"));
    drain(hold).await;
    let remembered = state.auto.session_snapshot("classify-1").unwrap();
    assert_eq!(remembered.sticky_band, "low");
    assert_eq!(remembered.model, "low-model");
    assert_eq!(
        upstream_models(&captured.lock().unwrap()),
        ["high-model", "high-model"]
    );
}

#[tokio::test]
async fn background_model_path_is_swapped_too() {
    let (state, _) = state_for(inverted(), vec![Scripted::ok()]).await;
    let mut config = state.config.clone();
    config.autoroute_background_by_client_model = true;
    let state = AppState::new(config).unwrap();
    let mut body = turn("bg-1");
    body["model"] = json!("claude-haiku-4");
    let response = send(&state, &body, &[]).await;
    assert_eq!(
        hv(&response, "x-octo-trigger").as_deref(),
        Some("background_model")
    );
    assert_eq!(hv(&response, "x-octo-model").as_deref(), Some("high-model"));
    assert_eq!(hv(&response, "x-octo-decided-tier").as_deref(), Some("low"));
}

#[tokio::test]
async fn ceiling_limits_the_swap_to_tiers_up_to_the_ceiling() {
    let (state, captured) = state_for(
        inverted(),
        vec![Scripted::ok(), Scripted::ok(), Scripted::ok()],
    )
    .await;
    let (decisions, _) =
        spawn_scripted_server("/v1/decisions", vec![Scripted::ok().with_body(JEV_LOW)]).await;
    let mut config = state.config.clone();
    config.openrouter_decisions_url = format!("http://{decisions}/v1/decisions");
    let state = AppState::new(config).unwrap();
    state.auto.seed_catalog(OpenRouterModels::default()).await;
    let _ = captured;

    let sub = [
        ("authorization", "Bearer sk-test"),
        ("x-octo-agent-role", "sub"),
        ("x-octo-tier-hint", "balanced"),
        ("x-octo-tier-policy", "ceiling"),
    ];
    let response = send(&state, &turn("ceil-1"), &sub).await;
    assert_eq!(hv(&response, "x-octo-model").as_deref(), Some("mid-model"));
    assert_eq!(hv(&response, "x-octo-tier").as_deref(), Some("mid"));
    assert_eq!(hv(&response, "x-octo-decided-tier").as_deref(), Some("low"));

    let at_low = send(
        &state,
        &turn("ceil-2"),
        &[
            ("x-octo-tier-hint", "fast"),
            ("x-octo-tier-policy", "ceiling"),
        ],
    )
    .await;
    assert_eq!(hv(&at_low, "x-octo-model").as_deref(), Some("low-model"));
    assert!(hv(&at_low, "x-octo-decided-tier").is_none());

    let at_high = send(
        &state,
        &turn("ceil-3"),
        &[("x-octo-tier-hint", "fast"), ("x-octo-tier-policy", "auto")],
    )
    .await;
    assert_eq!(hv(&at_high, "x-octo-model").as_deref(), Some("high-model"));
}

#[tokio::test]
async fn fixed_policy_is_never_swapped() {
    let (state, captured) = state_for(inverted(), vec![Scripted::ok()]).await;
    let response = send(
        &state,
        &turn("fixed-1"),
        &[
            ("x-octo-tier-hint", "fast"),
            ("x-octo-tier-policy", "fixed"),
        ],
    )
    .await;
    assert_eq!(hv(&response, "x-octo-model").as_deref(), Some("low-model"));
    assert_eq!(hv(&response, "x-octo-tier").as_deref(), Some("low"));
    assert!(hv(&response, "x-octo-decided-tier").is_none());
    assert!(hv(&response, "x-octo-price-swap").is_none());
    assert_eq!(upstream_models(&captured.lock().unwrap()), ["low-model"]);
}

#[tokio::test]
async fn an_unpriced_decided_tier_is_served_as_decided_over_http() {
    let (state, _) = state_for(table(None, None, Some(1.0)), vec![Scripted::ok()]).await;
    let response = send(&state, &turn("unpriced-1"), &[("x-octo-tier-hint", "fast")]).await;
    assert_eq!(hv(&response, "x-octo-model").as_deref(), Some("low-model"));
    assert!(hv(&response, "x-octo-decided-tier").is_none());
}

#[tokio::test]
async fn the_rule_off_serves_the_decided_tier() {
    let (state, _) = state_for(inverted(), vec![Scripted::ok()]).await;
    let mut config = state.config.clone();
    config.autoroute_never_pay_more_for_less = false;
    let state = AppState::new(config).unwrap();
    let response = send(&state, &turn("off-1"), &[("x-octo-tier-hint", "fast")]).await;
    assert_eq!(hv(&response, "x-octo-model").as_deref(), Some("low-model"));
    assert!(hv(&response, "x-octo-decided-tier").is_none());
    assert!(hv(&response, "x-octo-price-swap").is_none());
}

#[tokio::test]
async fn a_plain_retry_resends_the_served_model_and_keeps_the_swap_report() {
    let (state, captured) =
        state_for(inverted(), vec![Scripted::status(429), Scripted::ok()]).await;
    let response = send(&state, &turn("retry-1"), &[("x-octo-tier-hint", "fast")]).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(hv(&response, "x-octo-trigger").as_deref(), Some("retry"));
    assert_eq!(hv(&response, "x-octo-model").as_deref(), Some("high-model"));
    assert_eq!(hv(&response, "x-octo-decided-tier").as_deref(), Some("low"));
    assert_eq!(
        upstream_models(&captured.lock().unwrap()),
        ["high-model", "high-model"]
    );
}

#[tokio::test]
async fn an_unavailable_model_escalation_applies_the_rule_to_the_next_tier() {
    let prices = table(Some(1.0), Some(9.0), Some(2.0));
    let (state, captured) = state_for(
        prices,
        vec![
            Scripted::status(503).with_body(MODEL_UNAVAILABLE),
            Scripted::ok(),
        ],
    )
    .await;
    let response = send(&state, &turn("escalate-1"), &[("x-octo-tier-hint", "fast")]).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(hv(&response, "x-octo-trigger").as_deref(), Some("retry"));
    assert_eq!(hv(&response, "x-octo-model").as_deref(), Some("high-model"));
    assert_eq!(hv(&response, "x-octo-tier").as_deref(), Some("high"));
    assert_eq!(hv(&response, "x-octo-decided-tier").as_deref(), Some("mid"));
    assert_eq!(hv(&response, "x-octo-price-swap").as_deref(), Some("1"));
    assert_eq!(
        upstream_models(&captured.lock().unwrap()),
        ["low-model", "high-model"]
    );
}

#[tokio::test]
async fn an_unavailable_model_escalation_respects_a_ceiling() {
    let prices = table(Some(1.0), Some(9.0), Some(2.0));
    let (state, captured) = state_for(
        prices,
        vec![
            Scripted::status(503).with_body(MODEL_UNAVAILABLE),
            Scripted::ok(),
        ],
    )
    .await;
    let response = send(
        &state,
        &turn("escalate-2"),
        &[
            ("x-octo-tier-hint", "balanced"),
            ("x-octo-tier-policy", "ceiling"),
        ],
    )
    .await;
    // mid is decided (hint) and served at mid (ceiling mid leaves only mid); 503 -> next tier
    // high is above the ceiling, so there is no retry.
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(upstream_models(&captured.lock().unwrap()), ["mid-model"]);
}

// ---- decide-level: stall, compaction ----

fn decide_req<'a>(
    auto: &'a Auto,
    history: &'a History,
    client: &'a reqwest::Client,
    body: Value,
) -> DecideRequest<'a> {
    DecideRequest {
        auto,
        history,
        client,
        decisions_url: "http://127.0.0.1:9/decisions",
        api_key: "",
        body,
        allow_compact: true,
    }
}

fn paid(id: &str, window: u64) -> OpenRouterModel {
    OpenRouterModel {
        id: id.to_string(),
        name: id.to_string(),
        is_free: false,
        context_length: Some(window),
        max_completion_tokens: None,
        supported_parameters: Vec::new(),
    }
}

fn stalled_body(session: &str) -> Value {
    let input = json!({"command": "cargo test"});
    let call = json!({"role": "assistant", "content": [{"type": "tool_use", "name": "Bash", "input": input}]});
    let error = json!({"role": "user", "content": [{"type": "tool_result", "is_error": true, "content": "boom"}]});
    json!({
        "model": "client-model",
        "max_tokens": 16,
        "tools": [{"name": "Bash"}],
        "metadata": {"user_id": format!("{{\"session_id\":\"{session}\"}}")},
        "messages": [
            {"role": "user", "content": "go"},
            call, error, call, error, call, error
        ]
    })
}

fn forward_parts(turn: Turn) -> (String, octo::auto::RouteMeta) {
    let Turn::Forward(forward) = turn else {
        panic!("expected forward, got {turn:?}");
    };
    let value: Value = serde_json::from_slice(&forward.body).unwrap();
    (value["model"].as_str().unwrap().to_string(), forward.meta)
}

#[tokio::test]
async fn stall_escalation_decides_the_next_tier_and_serves_the_cheapest_above_it() {
    let auto = Auto::new(tiers_with(Some(9.0), Some(5.0), Some(1.0)));
    auto.seed_session(
        "stall-1",
        SessionChoice::fresh("low-model".into(), vec!["Bash".into()], "low".into()),
    );
    let (history, client) = (History::disabled(), reqwest::Client::new());
    let turn = decide_with(
        decide_req(&auto, &history, &client, stalled_body("stall-1")),
        &Hints::default(),
    )
    .await;
    let (model, meta) = forward_parts(turn);
    assert!(meta.trigger.starts_with("stall"), "{}", meta.trigger);
    assert_eq!(model, "high-model");
    assert_eq!(meta.tier_after, "high");
    assert_eq!(meta.decided_tier.as_deref(), Some("mid"));
    assert!(meta.price_swapped());
    let remembered = auto.session_snapshot("stall-1").unwrap();
    assert_eq!(remembered.sticky_band, "low");
    assert_eq!(remembered.model, "mid-model", "remembers the decided model");
}

#[tokio::test]
async fn stall_escalation_stops_at_a_ceiling() {
    let auto = Auto::new(tiers_with(Some(9.0), Some(5.0), Some(1.0)));
    auto.seed_session(
        "stall-2",
        SessionChoice::fresh("low-model".into(), vec!["Bash".into()], "low".into()),
    );
    let (history, client) = (History::disabled(), reqwest::Client::new());
    let hints = Hints {
        tier: Some("mid"),
        policy: TierPolicy::Ceiling,
        ..Hints::default()
    };
    let turn = decide_with(
        decide_req(&auto, &history, &client, stalled_body("stall-2")),
        &hints,
    )
    .await;
    let (model, meta) = forward_parts(turn);
    assert_eq!(model, "mid-model");
    assert_eq!(meta.tier_after, "mid");
    assert!(meta.decided_tier.is_none());
}

#[tokio::test]
async fn a_swapped_session_does_not_report_rerouting_every_turn() {
    let auto = Auto::new(tiers_with(Some(9.0), Some(5.0), Some(1.0)));
    auto.seed_session(
        "reroute-1",
        SessionChoice::fresh("low-model".into(), vec!["Read".into()], "low".into()),
    );
    let (history, client) = (History::disabled(), reqwest::Client::new());
    let turn = decide_with(
        decide_req(&auto, &history, &client, tool_result_turn("reroute-1")),
        &Hints::default(),
    )
    .await;
    let (model, meta) = forward_parts(turn);
    assert_eq!(model, "high-model");
    assert_eq!(meta.tier_before, "high");
    assert_eq!(meta.rerouting(), 0);
}

#[tokio::test]
async fn compaction_runs_on_the_served_model() {
    let auto = Auto::new(tiers_with(Some(9.0), Some(5.0), Some(1.0)));
    auto.seed_catalog(OpenRouterModels {
        free: Vec::new(),
        paid: vec![
            paid("low-model", 4_000),
            paid("mid-model", 4_000),
            paid("high-model", 4_000),
        ],
    })
    .await;
    auto.seed_session(
        "compact-1",
        SessionChoice::fresh("low-model".into(), vec!["Read".into()], "low".into()),
    );
    let (history, client) = (History::disabled(), reqwest::Client::new());
    let bulky = "x".repeat(12_000);
    let body = json!({
        "metadata": {"user_id": "{\"session_id\":\"compact-1\"}"},
        "max_tokens": 1024,
        "tools": [{"name": "Read"}],
        "messages": [{"role": "user", "content": [{"type": "tool_result", "tool_use_id": "1", "content": bulky}]}]
    });
    let turn = decide_with(
        decide_req(&auto, &history, &client, body),
        &Hints::default(),
    )
    .await;
    let Turn::Compact(compact) = turn else {
        panic!("expected compact, got {turn:?}");
    };
    assert_eq!(compact.model, "high-model");
    assert_eq!(compact.decided_tier.as_deref(), Some("low"));
}

// ---- config, warning ----

#[test]
fn the_rule_is_on_by_default_and_in_the_shipped_config_and_can_be_switched_off() {
    let shipped = Config::load_from_directory(std::path::Path::new("config")).unwrap();
    assert!(shipped.autoroute_never_pay_more_for_less);
    let state = AppState::new(shipped).unwrap();
    assert!(state.auto.tiers().never_pay_more_for_less);
    assert!(Tiers::new("a".into(), "b".into(), "c".into()).never_pay_more_for_less);

    let dir = std::env::temp_dir().join(format!(
        "octo-price-rule-{}",
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
        "[autoroute]\nnever_pay_more_for_less = false\n",
    )
    .unwrap();
    let config = Config::load_from_directory(&dir).unwrap();
    assert!(!config.autoroute_never_pay_more_for_less);
}

#[test]
fn the_shipped_ladder_is_inverted_and_the_rule_serves_everything_at_high() {
    let config = Config::load_from_directory(std::path::Path::new("config")).unwrap();
    let state = AppState::new(config).unwrap();
    let tiers = state.auto.tiers();
    assert_eq!(tiers.price_swap("low", None, shape()), Some("high"));
    assert_eq!(tiers.price_swap("mid", None, shape()), Some("high"));
    assert_eq!(tiers.blended_cost_micros("low", shape()), Some(1813));
    assert_eq!(tiers.blended_cost_micros("mid", shape()), Some(4800));
    assert_eq!(tiers.blended_cost_micros("high", shape()), Some(430));
}

#[test]
fn the_startup_warning_says_what_the_rule_does_or_that_it_is_off() {
    let mut on = tiers_with(Some(9.0), Some(5.0), Some(1.0));
    let warnings = ladder_warnings(&on);
    let note = warnings.last().unwrap();
    assert!(
        note.contains("never_pay_more_for_less is on")
            && note.contains("low is served by high")
            && note.contains("mid is served by high"),
        "{warnings:?}"
    );
    on.never_pay_more_for_less = false;
    let warnings = ladder_warnings(&on);
    assert!(
        warnings
            .last()
            .unwrap()
            .contains("never_pay_more_for_less is off"),
        "{warnings:?}"
    );
    assert!(ladder_warnings(&tiers_with(Some(1.0), Some(5.0), Some(9.0))).is_empty());
}
