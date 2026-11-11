mod support;

use std::net::SocketAddr;
use std::sync::{Arc, Mutex};

use axum::{
    body::{to_bytes, Body},
    extract::Request,
    http::{header, HeaderMap, HeaderValue, Request as HttpRequest, StatusCode},
    response::Response,
    routing::post,
    Router,
};
use octo::auto::{decide_with, Auto, DecideRequest, Hints, SessionChoice, TierPolicy, Tiers, Turn};
use octo::config::Config;
use octo::history::{History, ModelPrice, PriceTable};
use octo::providers::openrouter::{OpenRouterModel, OpenRouterModels};
use octo::routes;
use octo::state::AppState;
use serde_json::{json, Value};
use support::sample_config;
use tokio::net::TcpListener;
use tower::ServiceExt;

const COSTLY_OK: &str = r#"{"type":"message","role":"assistant","content":[],"usage":{"input_tokens":10,"output_tokens":5,"cost":2.0}}"#;
const PLAIN_OK: &str = r#"{"type":"message","role":"assistant","content":[],"usage":{"input_tokens":1000,"output_tokens":500}}"#;
const SSE_OK: &str = "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":100,\"output_tokens\":1}}}\n\nevent: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":7}}\n\n";
const JEV_LOW: &str = r#"{"is_hard":{"noul":0.1},"is_easy":{"noul":0.9}}"#;
const JEV_HIGH: &str = r#"{"is_hard":{"noul":0.9},"is_easy":{"noul":0.1}}"#;

#[derive(Clone)]
struct Reply {
    status: u16,
    content_type: &'static str,
    body: String,
}

fn json_reply(body: &str) -> Reply {
    Reply {
        status: 200,
        content_type: "application/json",
        body: body.to_string(),
    }
}

struct Mock {
    addr: SocketAddr,
    messages: Arc<Mutex<Vec<(HeaderMap, Value)>>>,
    jev_hits: Arc<Mutex<u32>>,
}

async fn spawn_mock(script: Vec<Reply>, jev: &'static str) -> Mock {
    let messages = Arc::new(Mutex::new(Vec::new()));
    let jev_hits = Arc::new(Mutex::new(0u32));
    let script = Arc::new(Mutex::new(script));
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let captured = messages.clone();
    let hits = jev_hits.clone();
    let app = Router::new()
        .route(
            "/v1/messages",
            post(move |request: Request| {
                let captured = captured.clone();
                let script = script.clone();
                async move {
                    let headers = request.headers().clone();
                    let bytes = to_bytes(request.into_body(), usize::MAX).await.unwrap();
                    let body = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
                    captured.lock().unwrap().push((headers, body));
                    let reply = {
                        let mut rows = script.lock().unwrap();
                        if rows.is_empty() {
                            json_reply(PLAIN_OK)
                        } else {
                            rows.remove(0)
                        }
                    };
                    let mut response = Response::new(Body::from(reply.body));
                    *response.status_mut() = StatusCode::from_u16(reply.status).unwrap();
                    response.headers_mut().insert(
                        header::CONTENT_TYPE,
                        HeaderValue::from_static(reply.content_type),
                    );
                    response
                }
            }),
        )
        .route(
            "/v1/decisions",
            post(move || {
                let hits = hits.clone();
                async move {
                    *hits.lock().unwrap() += 1;
                    ([(header::CONTENT_TYPE, "application/json")], jev)
                }
            }),
        );
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    Mock {
        addr,
        messages,
        jev_hits,
    }
}

fn config_for(addr: SocketAddr) -> Config {
    let mut config = sample_config(256 * 1024);
    config.openrouter_messages_url = format!("http://{addr}/v1/messages");
    config.openrouter_decisions_url = format!("http://{addr}/v1/decisions");
    config.llm_messages_backend = "openrouter".to_string();
    config.autoroute_low_model = "low-model".into();
    config.autoroute_mid_model = "mid-model".into();
    config.autoroute_high_model = "high-model".into();
    config
}

fn session_turn(session: &str) -> Value {
    json!({
        "model": "client-model",
        "max_tokens": 16,
        "metadata": {"user_id": format!("{{\"session_id\":\"{session}\"}}")},
        "messages": [{"role": "user", "content": "hi"}]
    })
}

async fn send(state: &AppState, body: &Value, extra: &[(&str, &str)]) -> Response {
    let mut builder = HttpRequest::builder()
        .method("POST")
        .uri("/autoroute/v1/messages")
        .header(header::CONTENT_TYPE, "application/json");
    for (name, value) in extra {
        builder = builder.header(*name, *value);
    }
    let request = builder
        .body(Body::from(serde_json::to_vec(body).unwrap()))
        .unwrap();
    routes::router(state.clone())
        .oneshot(request)
        .await
        .unwrap()
}

async fn get(state: &AppState, uri: &str) -> (StatusCode, Value) {
    let request = HttpRequest::builder()
        .method("GET")
        .uri(uri)
        .body(Body::empty())
        .unwrap();
    let response = routes::router(state.clone())
        .oneshot(request)
        .await
        .unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
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

async fn body_json(response: Response) -> Value {
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    serde_json::from_slice(&bytes).unwrap_or(Value::Null)
}

fn served_models(mock: &Mock) -> Vec<String> {
    mock.messages
        .lock()
        .unwrap()
        .iter()
        .map(|(_, body)| body["model"].as_str().unwrap_or_default().to_string())
        .collect()
}

const AUTH: (&str, &str) = ("authorization", "Bearer sk-test");

#[tokio::test]
async fn health_reports_service_and_capabilities() {
    let state = AppState::new(sample_config(1024)).unwrap();
    let (status, value) = get(&state, "/health").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(value["service"], "octo");
    assert_eq!(
        value["capabilities"],
        json!([
            "autoroute",
            "route_hints",
            "result_headers",
            "budget_key",
            "route_api"
        ])
    );
    assert_eq!(value["status"], "ok");
}

#[test]
fn hints_parse_valid_values_and_ignore_invalid_ones() {
    let mut headers = HeaderMap::new();
    for (name, value) in [
        ("x-octo-budget-key", "proj-1"),
        ("x-octo-budget-usd", "0.25"),
        ("x-octo-agent-role", "sub"),
        ("x-octo-agent-depth", "2"),
        ("x-octo-tier-hint", "deep"),
        ("x-octo-tier-policy", "ceiling"),
        ("x-octo-task", "Fix%20the%20bug%20in%20%E2%9C%93+now"),
    ] {
        headers.insert(name, HeaderValue::from_static(value));
    }
    let hints = Hints::take(&mut headers).unwrap();
    assert!(headers.is_empty(), "every hint header is consumed");
    assert_eq!(hints.budget_key.as_deref(), Some("proj-1"));
    assert_eq!(hints.budget_micros, Some(250_000));
    assert!(hints.is_sub());
    assert_eq!(hints.depth, Some(2));
    assert_eq!(hints.tier, Some("high"));
    assert_eq!(hints.policy, TierPolicy::Ceiling);
    assert_eq!(hints.task.as_deref(), Some("Fix the bug in \u{2713} now"));

    let mut bad = HeaderMap::new();
    for (name, value) in [
        ("x-octo-budget-key", "has space"),
        ("x-octo-budget-usd", "abc"),
        ("x-octo-agent-role", "boss"),
        ("x-octo-agent-depth", "-1"),
        ("x-octo-tier-policy", "maybe"),
        ("x-octo-task", "%zz"),
    ] {
        bad.insert(name, HeaderValue::from_static(value));
    }
    let hints = Hints::take(&mut bad).unwrap();
    assert_eq!(hints, Hints::default());

    let mut long = HeaderMap::new();
    long.insert(
        "x-octo-task",
        HeaderValue::from_str(&"a".repeat(500)).unwrap(),
    );
    assert_eq!(
        Hints::take(&mut long)
            .unwrap()
            .task
            .unwrap()
            .chars()
            .count(),
        200
    );

    let mut orphan = HeaderMap::new();
    orphan.insert("x-octo-budget-usd", HeaderValue::from_static("1.0"));
    assert_eq!(
        Hints::take(&mut orphan).unwrap().budget_micros,
        None,
        "a budget needs a budget key"
    );
}

#[tokio::test]
async fn hint_headers_are_stripped_before_upstream() {
    let mock = spawn_mock(vec![], JEV_LOW).await;
    let state = AppState::new(config_for(mock.addr)).unwrap();
    let response = send(
        &state,
        &session_turn("strip"),
        &[
            ("x-octo-budget-key", "p"),
            ("x-octo-budget-usd", "5"),
            ("x-octo-agent-role", "orchestrator"),
            ("x-octo-agent-depth", "0"),
            ("x-octo-tier-hint", "balanced"),
            ("x-octo-tier-policy", "auto"),
            ("x-octo-task", "do%20it"),
        ],
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let rows = mock.messages.lock().unwrap().clone();
    assert_eq!(rows.len(), 1);
    for (name, _) in rows[0].0.iter() {
        assert!(!name.as_str().starts_with("x-octo-"), "leaked {name}");
    }
    assert!(rows[0].1.get("x-octo-tier-hint").is_none());
}

#[tokio::test]
async fn tier_hint_sets_the_starting_tier_of_a_new_session() {
    let mock = spawn_mock(vec![], JEV_LOW).await;
    let state = AppState::new(config_for(mock.addr)).unwrap();
    for (hint, session, model, tier) in [
        ("fast", "s-fast", "low-model", "low"),
        ("balanced", "s-bal", "mid-model", "mid"),
        ("deep", "s-deep", "high-model", "high"),
    ] {
        let response = send(
            &state,
            &session_turn(session),
            &[("x-octo-tier-hint", hint)],
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(hv(&response, "x-octo-model"), model);
        assert_eq!(hv(&response, "x-octo-tier"), tier);
        assert_eq!(hv(&response, "x-octo-trigger"), "hint");
    }
    assert_eq!(
        served_models(&mock),
        ["low-model", "mid-model", "high-model"]
    );
    assert_eq!(
        *mock.jev_hits.lock().unwrap(),
        0,
        "an orchestrator hint skips the classifier"
    );
}

#[tokio::test]
async fn sub_agent_session_starts_at_min_of_hint_and_classifier() {
    let low = spawn_mock(vec![], JEV_LOW).await;
    let state = AppState::new(config_for(low.addr)).unwrap();
    let response = send(
        &state,
        &session_turn("sub-1"),
        &[
            AUTH,
            ("x-octo-agent-role", "sub"),
            ("x-octo-tier-hint", "deep"),
            ("x-octo-task", "rename%20a%20variable"),
        ],
    )
    .await;
    assert_eq!(hv(&response, "x-octo-model"), "low-model");
    assert_eq!(hv(&response, "x-octo-trigger"), "classify");
    assert_eq!(*low.jev_hits.lock().unwrap(), 1);

    let high = spawn_mock(vec![], JEV_HIGH).await;
    let state = AppState::new(config_for(high.addr)).unwrap();
    let response = send(
        &state,
        &session_turn("sub-2"),
        &[
            AUTH,
            ("x-octo-agent-depth", "1"),
            ("x-octo-tier-hint", "balanced"),
        ],
    )
    .await;
    assert_eq!(hv(&response, "x-octo-model"), "mid-model");
    assert_eq!(hv(&response, "x-octo-trigger"), "hint");
}

#[tokio::test]
async fn task_hint_reaches_the_classifier_as_context() {
    let captured = Arc::new(Mutex::new(String::new()));
    let seen = captured.clone();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let app = Router::new()
        .route(
            "/v1/decisions",
            post(move |request: Request| {
                let seen = seen.clone();
                async move {
                    let bytes = to_bytes(request.into_body(), usize::MAX).await.unwrap();
                    *seen.lock().unwrap() = String::from_utf8_lossy(&bytes).into_owned();
                    ([(header::CONTENT_TYPE, "application/json")], JEV_LOW)
                }
            }),
        )
        .route("/v1/messages", post(|| async { PLAIN_OK }));
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let state = AppState::new(config_for(addr)).unwrap();
    let response = send(
        &state,
        &session_turn("task-ctx"),
        &[
            AUTH,
            ("x-octo-agent-role", "sub"),
            ("x-octo-tier-hint", "deep"),
            ("x-octo-task", "Migrate%20the%20billing%20table"),
        ],
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    assert!(captured
        .lock()
        .unwrap()
        .contains("Task: Migrate the billing table"));
}

#[tokio::test]
async fn ceiling_clamps_an_existing_higher_session_and_fixed_serves_the_hint() {
    let mock = spawn_mock(vec![], JEV_HIGH).await;
    let state = AppState::new(config_for(mock.addr)).unwrap();
    state.auto.seed_session(
        "high-sess",
        SessionChoice::fresh("high-model".into(), vec![], "high".into()),
    );
    let response = send(
        &state,
        &session_turn("high-sess"),
        &[
            AUTH,
            ("x-octo-tier-hint", "balanced"),
            ("x-octo-tier-policy", "ceiling"),
        ],
    )
    .await;
    assert_eq!(hv(&response, "x-octo-model"), "mid-model");
    assert_eq!(hv(&response, "x-octo-tier"), "mid");
    assert_eq!(hv(&response, "x-octo-trigger"), "hint");

    let hits_before = *mock.jev_hits.lock().unwrap();
    state.auto.seed_session(
        "fixed-sess",
        SessionChoice::fresh("high-model".into(), vec![], "high".into()),
    );
    let response = send(
        &state,
        &session_turn("fixed-sess"),
        &[
            AUTH,
            ("x-octo-tier-hint", "fast"),
            ("x-octo-tier-policy", "fixed"),
        ],
    )
    .await;
    assert_eq!(hv(&response, "x-octo-model"), "low-model");
    assert_eq!(hv(&response, "x-octo-trigger"), "hint");
    assert_eq!(
        *mock.jev_hits.lock().unwrap(),
        hits_before,
        "fixed never classifies"
    );
}

fn stall_body() -> Value {
    serde_json::from_str(include_str!("fixtures/stall_repeated_edit.json")).unwrap()
}

async fn decide_model(auto: &Auto, hints: &Hints) -> (String, String) {
    let history = History::disabled();
    let client = reqwest::Client::new();
    let turn = decide_with(
        DecideRequest {
            auto,
            history: &history,
            client: &client,
            decisions_url: "http://127.0.0.1:9/decisions",
            api_key: "",
            body: stall_body(),
            allow_compact: true,
        },
        hints,
    )
    .await;
    let Turn::Forward(forward) = turn else {
        panic!("expected forward, got {turn:?}");
    };
    let payload: Value = serde_json::from_slice(&forward.body).unwrap();
    (
        payload["model"].as_str().unwrap().to_string(),
        forward.meta.trigger,
    )
}

fn stall_tiers() -> Tiers {
    let mut tiers = Tiers::new("low-m".into(), "mid-m".into(), "high-m".into());
    tiers.escalate_turns = 3;
    tiers
}

#[tokio::test]
async fn stall_escalates_under_auto_but_not_past_a_ceiling_or_fixed_hint() {
    let hint = |policy| Hints {
        tier: Some("low"),
        policy,
        ..Hints::default()
    };
    let (model, trigger) = decide_model(&Auto::new(stall_tiers()), &hint(TierPolicy::Auto)).await;
    assert_eq!(model, "mid-m", "auto may escalate on a stall");
    assert!(trigger.starts_with("stall:"), "{trigger}");

    let (model, trigger) =
        decide_model(&Auto::new(stall_tiers()), &hint(TierPolicy::Ceiling)).await;
    assert_eq!(model, "low-m", "ceiling holds under stall");
    assert_eq!(trigger, "hint");

    let (model, trigger) = decide_model(&Auto::new(stall_tiers()), &hint(TierPolicy::Fixed)).await;
    assert_eq!(model, "low-m");
    assert_eq!(trigger, "hint");

    let high_ceiling = Hints {
        tier: Some("high"),
        policy: TierPolicy::Ceiling,
        ..Hints::default()
    };
    let (model, _) = decide_model(&Auto::new(stall_tiers()), &high_ceiling).await;
    assert_eq!(model, "high-m");
}

#[tokio::test]
async fn ceiling_blocks_unavailable_model_escalation_retry() {
    let unavailable = Reply {
        status: 429,
        content_type: "application/json",
        body: r#"{"error":{"message":"No available model provider"}}"#.to_string(),
    };
    let mock = spawn_mock(vec![unavailable.clone(), json_reply(PLAIN_OK)], JEV_LOW).await;
    let state = AppState::new(config_for(mock.addr)).unwrap();
    let response = send(
        &state,
        &session_turn("ceil-retry"),
        &[
            ("x-octo-tier-hint", "fast"),
            ("x-octo-tier-policy", "ceiling"),
        ],
    )
    .await;
    assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(
        served_models(&mock),
        ["low-model"],
        "no escalation above the ceiling"
    );

    let mock = spawn_mock(vec![unavailable, json_reply(PLAIN_OK)], JEV_LOW).await;
    let state = AppState::new(config_for(mock.addr)).unwrap();
    let response = send(
        &state,
        &session_turn("auto-retry"),
        &[("x-octo-tier-hint", "fast")],
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(served_models(&mock), ["low-model", "mid-model"]);
}

#[tokio::test]
async fn result_headers_on_non_streaming_response() {
    let mock = spawn_mock(vec![], JEV_LOW).await;
    let state = AppState::new(config_for(mock.addr)).unwrap();
    let response = send(
        &state,
        &session_turn("rh-1"),
        &[("x-octo-tier-hint", "balanced")],
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(hv(&response, "x-octo-model"), "mid-model");
    assert_eq!(hv(&response, "x-octo-tier"), "mid");
    assert_eq!(hv(&response, "x-octo-trigger"), "hint");
    assert!(hv(&response, "x-octo-request-id").starts_with("octo_"));
    assert!(response.headers().get("x-octo-budget-usd").is_none());
    assert!(response.headers().get("x-octo-spent-usd").is_none());
}

#[tokio::test]
async fn result_headers_are_set_before_a_streamed_body() {
    let mock = spawn_mock(
        vec![Reply {
            status: 200,
            content_type: "text/event-stream",
            body: SSE_OK.to_string(),
        }],
        JEV_LOW,
    )
    .await;
    let state = AppState::new(config_for(mock.addr)).unwrap();
    let mut body = session_turn("rh-stream");
    body["stream"] = json!(true);
    let response = send(
        &state,
        &body,
        &[
            ("x-octo-tier-hint", "fast"),
            ("x-octo-budget-key", "proj-stream"),
            ("x-octo-budget-usd", "3"),
        ],
    )
    .await;
    assert_eq!(hv(&response, "x-octo-model"), "low-model");
    assert_eq!(hv(&response, "x-octo-tier"), "low");
    assert_eq!(hv(&response, "x-octo-trigger"), "hint");
    assert_eq!(hv(&response, "x-octo-budget-usd"), "3.000000");
    assert_eq!(hv(&response, "x-octo-spent-usd"), "0.000000");
    let id = hv(&response, "x-octo-request-id");
    assert_eq!(
        response.headers().get(header::CONTENT_TYPE).unwrap(),
        "text/event-stream"
    );
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    assert_eq!(bytes.as_ref(), SSE_OK.as_bytes());
    let (status, row) = get(&state, &format!("/autoroute/v1/calls/{id}")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(row["model"], "low-model");
    assert_eq!(row["input_tokens"], 100);
    assert_eq!(row["output_tokens"], 7);
}

fn priced_state(addr: SocketAddr) -> AppState {
    let mut state = AppState::new(config_for(addr)).unwrap();
    let price = ModelPrice {
        input: 1.0,
        cache_read: 0.0,
        cache_write: 0.0,
        output: 2.0,
        billed_as: None,
        rates_complete: true,
    };
    state.history = History::disabled().with_prices(PriceTable::new(vec![
        ("low-model".into(), price.clone()),
        ("mid-model".into(), price.clone()),
        ("high-model".into(), price),
    ]));
    state
}

#[tokio::test]
async fn calls_endpoint_is_404_until_the_response_has_finished() {
    let mock = spawn_mock(vec![json_reply(COSTLY_OK), json_reply(PLAIN_OK)], JEV_LOW).await;
    let state = priced_state(mock.addr);
    let (status, _) = get(&state, "/autoroute/v1/calls/octo_unknown").await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    let response = send(
        &state,
        &session_turn("calls-1"),
        &[("x-octo-tier-hint", "balanced")],
    )
    .await;
    let id = hv(&response, "x-octo-request-id");
    let (before, _) = get(&state, &format!("/autoroute/v1/calls/{id}")).await;
    assert_eq!(before, StatusCode::NOT_FOUND, "body not consumed yet");
    let _ = body_json(response).await;
    let (status, row) = get(&state, &format!("/autoroute/v1/calls/{id}")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(row["model"], "mid-model");
    assert_eq!(row["tier"], "mid");
    assert_eq!(row["trigger"], "hint");
    assert_eq!(row["input_tokens"], 10);
    assert_eq!(row["output_tokens"], 5);
    assert_eq!(row["cache_read_tokens"], 0);
    assert_eq!(row["cache_write_tokens"], 0);
    assert_eq!(row["cost_source"], "reported");
    assert!((row["cost_usd"].as_f64().unwrap() - 2.0).abs() < 1e-9);

    let response = send(
        &state,
        &session_turn("calls-2"),
        &[("x-octo-tier-hint", "fast")],
    )
    .await;
    let id = hv(&response, "x-octo-request-id");
    let _ = body_json(response).await;
    let (status, row) = get(&state, &format!("/autoroute/v1/calls/{id}")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(row["cost_source"], "estimated");
    assert_eq!(row["input_tokens"], 1000);
    assert_eq!(row["output_tokens"], 500);
    assert!((row["cost_usd"].as_f64().unwrap() - 0.002).abs() < 1e-9);
}

#[tokio::test]
async fn failed_requests_get_a_call_row_too() {
    let mock = spawn_mock(
        vec![Reply {
            status: 400,
            content_type: "application/json",
            body: r#"{"type":"error","error":{"type":"invalid_request_error","message":"bad"}}"#
                .to_string(),
        }],
        JEV_LOW,
    )
    .await;
    let state = priced_state(mock.addr);
    let response = send(
        &state,
        &session_turn("calls-fail"),
        &[("x-octo-tier-hint", "fast")],
    )
    .await;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let id = hv(&response, "x-octo-request-id");
    let _ = body_json(response).await;
    let (status, row) = get(&state, &format!("/autoroute/v1/calls/{id}")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(row["model"], "low-model");
    assert_eq!(row["input_tokens"], 0);
    assert_eq!(row["output_tokens"], 0);
}

#[tokio::test]
async fn dropped_responses_get_a_call_row() {
    let mock = spawn_mock(vec![], JEV_LOW).await;
    let state = priced_state(mock.addr);
    let response = send(
        &state,
        &session_turn("calls-drop"),
        &[("x-octo-tier-hint", "fast")],
    )
    .await;
    let id = hv(&response, "x-octo-request-id");
    drop(response);
    let (status, row) = get(&state, &format!("/autoroute/v1/calls/{id}")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(row["model"], "low-model");
}

#[tokio::test]
async fn budget_key_is_shared_across_sessions_and_header_budget_rejects() {
    let mock = spawn_mock(vec![json_reply(COSTLY_OK), json_reply(PLAIN_OK)], JEV_LOW).await;
    let mut config = config_for(mock.addr);
    config.autoroute_session_budget_usd = 100.0;
    let state = AppState::new(config).unwrap();
    let key = [
        ("x-octo-budget-key", "proj-9"),
        ("x-octo-budget-usd", "0.01"),
        ("x-octo-tier-hint", "fast"),
    ];
    let first = send(&state, &session_turn("agent-a"), &key).await;
    assert_eq!(first.status(), StatusCode::OK);
    assert_eq!(hv(&first, "x-octo-budget-usd"), "0.010000");
    assert_eq!(hv(&first, "x-octo-spent-usd"), "0.000000");
    let _ = body_json(first).await;

    let second = send(&state, &session_turn("agent-b"), &key).await;
    assert_eq!(second.status(), StatusCode::PAYMENT_REQUIRED);
    assert_eq!(hv(&second, "x-octo-budget-usd"), "0.010000");
    assert_eq!(hv(&second, "x-octo-spent-usd"), "2.000000");
    assert_eq!(hv(&second, "x-octo-trigger"), "budget");
    let value = body_json(second).await;
    assert_eq!(value["type"], "error");
    assert_eq!(value["error"]["type"], "billing_error");
    let message = value["error"]["message"].as_str().unwrap();
    assert!(
        message.contains("$2.000000")
            && message.contains("$0.010000")
            && message.contains("proj-9"),
        "{message}"
    );
    assert_eq!(
        mock.messages.lock().unwrap().len(),
        1,
        "no second upstream call"
    );

    let other = send(
        &state,
        &session_turn("agent-c"),
        &[("x-octo-tier-hint", "fast")],
    )
    .await;
    assert_eq!(other.status(), StatusCode::OK, "other keys are unaffected");
}

#[tokio::test]
async fn budget_key_works_without_a_session_id() {
    let mock = spawn_mock(vec![json_reply(COSTLY_OK)], JEV_LOW).await;
    let state = AppState::new(config_for(mock.addr)).unwrap();
    let body =
        json!({"model": "m", "max_tokens": 16, "messages": [{"role": "user", "content": "hi"}]});
    let key = [
        ("x-octo-budget-key", "no-session"),
        ("x-octo-budget-usd", "1"),
        ("x-octo-tier-hint", "fast"),
    ];
    let first = send(&state, &body, &key).await;
    assert_eq!(first.status(), StatusCode::OK);
    let _ = body_json(first).await;
    let second = send(&state, &body, &key).await;
    assert_eq!(second.status(), StatusCode::PAYMENT_REQUIRED);
}

#[tokio::test]
async fn effective_budget_is_the_smaller_of_header_and_config() {
    let mock = spawn_mock(vec![], JEV_LOW).await;

    let mut config = config_for(mock.addr);
    config.autoroute_session_budget_usd = 1.0;
    let state = AppState::new(config).unwrap();
    let response = send(
        &state,
        &session_turn("min-1"),
        &[
            ("x-octo-budget-key", "k1"),
            ("x-octo-budget-usd", "5"),
            ("x-octo-tier-hint", "fast"),
        ],
    )
    .await;
    assert_eq!(
        hv(&response, "x-octo-budget-usd"),
        "1.000000",
        "config is smaller"
    );

    let mut config = config_for(mock.addr);
    config.autoroute_session_budget_usd = 5.0;
    let state = AppState::new(config).unwrap();
    let response = send(
        &state,
        &session_turn("min-2"),
        &[
            ("x-octo-budget-key", "k2"),
            ("x-octo-budget-usd", "0.5"),
            ("x-octo-tier-hint", "fast"),
        ],
    )
    .await;
    assert_eq!(
        hv(&response, "x-octo-budget-usd"),
        "0.500000",
        "header is smaller"
    );

    let state = AppState::new(config_for(mock.addr)).unwrap();
    let response = send(
        &state,
        &session_turn("min-3"),
        &[
            ("x-octo-budget-key", "k3"),
            ("x-octo-budget-usd", "0.25"),
            ("x-octo-tier-hint", "fast"),
        ],
    )
    .await;
    assert_eq!(hv(&response, "x-octo-budget-usd"), "0.250000", "config off");
}

#[tokio::test]
async fn config_budget_below_the_header_keeps_the_configured_action() {
    let mock = spawn_mock(vec![json_reply(COSTLY_OK)], JEV_LOW).await;
    let mut config = config_for(mock.addr);
    config.autoroute_session_budget_usd = 0.5;
    config.autoroute_session_budget_action = "downgrade".to_string();
    let state = AppState::new(config).unwrap();
    let key = [
        ("x-octo-budget-key", "k4"),
        ("x-octo-budget-usd", "50"),
        ("x-octo-tier-hint", "deep"),
    ];
    let first = send(&state, &session_turn("cfg-a"), &key).await;
    let _ = body_json(first).await;
    let second = send(&state, &session_turn("cfg-b"), &key).await;
    assert_eq!(second.status(), StatusCode::OK, "downgrade, not reject");
    assert_eq!(hv(&second, "x-octo-trigger"), "budget_cap");
}

#[tokio::test]
async fn invalid_hint_values_other_than_the_tier_are_ignored_never_rejected() {
    let mock = spawn_mock(vec![], JEV_LOW).await;
    let state = AppState::new(config_for(mock.addr)).unwrap();
    let response = send(
        &state,
        &session_turn("bad-hints"),
        &[
            ("x-octo-tier-policy", "maybe"),
            ("x-octo-agent-role", "boss"),
            ("x-octo-agent-depth", "deep"),
            ("x-octo-budget-key", "bad key"),
            ("x-octo-budget-usd", "lots"),
            ("x-octo-task", "%zz"),
        ],
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_ne!(hv(&response, "x-octo-trigger"), "hint");
    assert!(response.headers().get("x-octo-budget-usd").is_none());
}

fn catalog(window: u64) -> OpenRouterModels {
    OpenRouterModels {
        free: vec![],
        paid: ["low-model", "mid-model", "high-model"]
            .into_iter()
            .map(|id| OpenRouterModel {
                id: id.into(),
                name: id.into(),
                is_free: false,
                context_length: Some(window),
                max_completion_tokens: Some(4096),
                supported_parameters: vec!["max_tokens".into(), "tools".into()],
            })
            .collect(),
    }
}

#[tokio::test]
async fn compaction_response_is_identifiable_by_trigger_header() {
    let summary = json!({
        "type": "message",
        "role": "assistant",
        "stop_reason": "compaction",
        "content": [{"type": "compaction", "content": "summary of the conversation"}],
        "usage": {"input_tokens": 12000, "output_tokens": 300}
    })
    .to_string();
    let mock = spawn_mock(vec![json_reply(&summary)], JEV_LOW).await;
    let state = priced_state(mock.addr);
    state.auto.seed_catalog(catalog(16_000)).await;
    let mut body = session_turn("compact-1");
    body["messages"] = json!([{"role": "user", "content": "x".repeat(60_000)}]);
    body["tools"] = json!([{"name": "Read"}]);
    let response = send(
        &state,
        &body,
        &[
            ("x-octo-tier-hint", "balanced"),
            ("x-octo-budget-key", "proj-c"),
            ("x-octo-budget-usd", "9"),
        ],
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(hv(&response, "x-octo-trigger"), "compact");
    assert_eq!(hv(&response, "x-octo-model"), "mid-model");
    assert_eq!(hv(&response, "x-octo-tier"), "mid");
    assert_eq!(hv(&response, "x-octo-budget-usd"), "9.000000");
    let id = hv(&response, "x-octo-request-id");
    let value = body_json(response).await;
    assert_eq!(value["stop_reason"], "compaction");
    assert_eq!(value["content"][0]["type"], "compaction");
    let rows = mock.messages.lock().unwrap().clone();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].1["compaction"]["type"], "summarize");
    assert_eq!(rows[0].1["stream"], false);
    assert_eq!(
        rows[0].0.get("anthropic-beta").unwrap(),
        "compact-2026-09-04"
    );
    let (status, row) = get(&state, &format!("/autoroute/v1/calls/{id}")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(row["trigger"], "compact");
    assert_eq!(row["input_tokens"], 12000);
    assert_eq!(row["cost_source"], "estimated");
}

struct Served {
    models: Vec<String>,
    tiers: Vec<String>,
    triggers: Vec<String>,
    classifier_hits: u32,
}

async fn serve_stalled_session(policy: &str, turns: usize) -> Served {
    let mock = spawn_mock(vec![], JEV_HIGH).await;
    let mut config = config_for(mock.addr);
    config.autoroute_escalate_turns = 3;
    let state = AppState::new(config).unwrap();
    let mut served = Served {
        models: Vec::new(),
        tiers: Vec::new(),
        triggers: Vec::new(),
        classifier_hits: 0,
    };
    for _ in 0..turns {
        let response = send(
            &state,
            &stall_body(),
            &[
                AUTH,
                ("x-octo-tier-hint", "fast"),
                ("x-octo-tier-policy", policy),
            ],
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        served.models.push(hv(&response, "x-octo-model"));
        served.tiers.push(hv(&response, "x-octo-tier"));
        served.triggers.push(hv(&response, "x-octo-trigger"));
        let _ = body_json(response).await;
    }
    served.classifier_hits = *mock.jev_hits.lock().unwrap();
    assert_eq!(
        served_models(&mock),
        served.models,
        "headers match upstream"
    );
    served
}

#[tokio::test]
async fn ceiling_never_serves_above_the_hint_across_a_session_that_would_escalate() {
    let control = serve_stalled_session("auto", 5).await;
    assert!(
        control.models.iter().any(|model| model != "low-model"),
        "control: without a ceiling the stalled, hard session escalates: {:?}",
        control.models
    );
    assert!(control.triggers.iter().any(|t| t.starts_with("stall:")));

    let ceiling = serve_stalled_session("ceiling", 5).await;
    assert_eq!(ceiling.models, ["low-model"; 5], "{:?}", ceiling.triggers);
    assert_eq!(ceiling.tiers, ["low"; 5]);
}

#[tokio::test]
async fn fixed_serves_the_hint_tier_on_every_turn_and_never_classifies() {
    let fixed = serve_stalled_session("fixed", 5).await;
    assert_eq!(fixed.models, ["low-model"; 5]);
    assert_eq!(fixed.tiers, ["low"; 5]);
    assert_eq!(fixed.triggers, ["hint"; 5]);
    assert_eq!(fixed.classifier_hits, 0);
}

fn compaction_summary() -> Reply {
    json_reply(
        &json!({
            "type": "message",
            "role": "assistant",
            "stop_reason": "compaction",
            "content": [{"type": "compaction", "content": "summary of the conversation"}],
            "usage": {"input_tokens": 12000, "output_tokens": 300}
        })
        .to_string(),
    )
}

fn long_history(session: &str) -> Value {
    let mut body = session_turn(session);
    body["messages"] = json!([{"role": "user", "content": "x".repeat(60_000)}]);
    body["tools"] = json!([{"name": "Read"}]);
    body
}

fn compacted_history(session: &str, summary: &str, extra_rounds: usize) -> Value {
    let mut body = session_turn(session);
    let mut messages = vec![
        json!({"role": "user", "content": format!("Summary of the conversation so far:\n{summary}")}),
        json!({"role": "user", "content": "continue with the next step"}),
    ];
    for i in 0..extra_rounds {
        messages.push(json!({"role": "assistant", "content": [{"type": "tool_use", "id": format!("t{i}"), "name": "Read", "input": {"n": i}}]}));
        messages.push(json!({"role": "user", "content": [{"type": "tool_result", "tool_use_id": format!("t{i}"), "content": "ok"}]}));
    }
    body["messages"] = json!(messages);
    body["tools"] = json!([{"name": "Read"}]);
    body
}

const COMPACT_HINTS: [(&str, &str); 2] = [
    ("x-octo-tier-hint", "balanced"),
    ("x-octo-budget-key", "proj-round-trip"),
];

fn compaction_requests(mock: &Mock) -> usize {
    mock.messages
        .lock()
        .unwrap()
        .iter()
        .filter(|(_, body)| body.get("compaction").is_some())
        .count()
}

#[tokio::test]
async fn compaction_round_trip_applied_by_the_client_is_not_repeated() {
    let mock = spawn_mock(vec![compaction_summary()], JEV_LOW).await;
    let state = priced_state(mock.addr);
    state.auto.seed_catalog(catalog(16_000)).await;

    let response = send(&state, &long_history("round-trip"), &COMPACT_HINTS).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(hv(&response, "x-octo-trigger"), "compact");
    let summary = body_json(response).await;
    assert_eq!(summary["stop_reason"], "compaction");
    let text = summary["content"][0]["content"]
        .as_str()
        .unwrap()
        .to_string();
    assert_eq!(text, "summary of the conversation");

    let shortened = compacted_history("round-trip", &text, 0);
    let response = send(&state, &shortened, &COMPACT_HINTS).await;
    assert_eq!(response.status(), StatusCode::OK);
    let trigger = hv(&response, "x-octo-trigger");
    assert!(
        trigger != "compact" && trigger != "compact_not_applied",
        "applied compaction is forwarded normally: {trigger}"
    );
    let _ = body_json(response).await;

    let rows = mock.messages.lock().unwrap().clone();
    assert_eq!(rows.len(), 2, "one compaction call, one normal call");
    assert!(rows[1].1.get("compaction").is_none());
    assert_eq!(rows[1].1["messages"], shortened["messages"]);

    for rounds in 1..=3 {
        let next = compacted_history("round-trip", &text, rounds);
        let response = send(&state, &next, &COMPACT_HINTS).await;
        assert_eq!(response.status(), StatusCode::OK);
        let trigger = hv(&response, "x-octo-trigger");
        assert!(
            trigger != "compact" && trigger != "compact_not_applied",
            "round {rounds}: {trigger}"
        );
        let _ = body_json(response).await;
    }
    assert_eq!(compaction_requests(&mock), 1, "never compacted again");
    assert_eq!(mock.messages.lock().unwrap().len(), 5);
}

#[tokio::test]
async fn compaction_ignored_by_the_client_is_forwarded_as_not_applied_once() {
    let mock = spawn_mock(vec![compaction_summary()], JEV_LOW).await;
    let state = priced_state(mock.addr);
    state.auto.seed_catalog(catalog(16_000)).await;

    let response = send(&state, &long_history("ignored"), &COMPACT_HINTS).await;
    assert_eq!(hv(&response, "x-octo-trigger"), "compact");
    let _ = body_json(response).await;

    let same = long_history("ignored");
    let response = send(&state, &same, &COMPACT_HINTS).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(hv(&response, "x-octo-trigger"), "compact_not_applied");
    let _ = body_json(response).await;
    let rows = mock.messages.lock().unwrap().clone();
    assert_eq!(rows.len(), 2);
    assert!(rows[1].1.get("compaction").is_none());
    assert_eq!(
        rows[1].1["messages"], same["messages"],
        "the long history is forwarded untouched"
    );

    let response = send(&state, &same, &COMPACT_HINTS).await;
    assert_ne!(hv(&response, "x-octo-trigger"), "compact");
    assert_ne!(hv(&response, "x-octo-trigger"), "compact_not_applied");
    let _ = body_json(response).await;
    assert_eq!(
        compaction_requests(&mock),
        1,
        "not asked again while ignored"
    );
}

// ---- live run 2: tier hint aliases, estimate ratio, upstream id ----

#[tokio::test]
async fn tier_hint_accepts_low_mid_high_aliases_case_insensitively() {
    let mock = spawn_mock(vec![], JEV_LOW).await;
    let state = AppState::new(config_for(mock.addr)).unwrap();
    for (hint, session, model, tier) in [
        ("low", "a-low", "low-model", "low"),
        ("MID", "a-mid", "mid-model", "mid"),
        ("High", "a-high", "high-model", "high"),
        ("FAST", "a-fast", "low-model", "low"),
        ("Balanced", "a-bal", "mid-model", "mid"),
        ("deep", "a-deep", "high-model", "high"),
    ] {
        let response = send(
            &state,
            &session_turn(session),
            &[("x-octo-tier-hint", hint)],
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK, "{hint}");
        assert_eq!(hv(&response, "x-octo-model"), model, "{hint}");
        assert_eq!(hv(&response, "x-octo-tier"), tier, "{hint}");
        assert_eq!(hv(&response, "x-octo-trigger"), "hint", "{hint}");
    }
}

#[tokio::test]
async fn an_unknown_tier_hint_is_a_400_naming_the_accepted_values() {
    let mock = spawn_mock(vec![], JEV_LOW).await;
    let state = AppState::new(config_for(mock.addr)).unwrap();
    for uri in ["/autoroute/v1/messages", "/autoroute/v1/chat/completions"] {
        let request = HttpRequest::builder()
            .method("POST")
            .uri(uri)
            .header(header::CONTENT_TYPE, "application/json")
            .header("x-octo-tier-hint", "ultra")
            .body(Body::from(
                serde_json::to_vec(&session_turn("bad-hint")).unwrap(),
            ))
            .unwrap();
        let response = routes::router(state.clone())
            .oneshot(request)
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST, "{uri}");
        let text = body_json(response).await.to_string();
        for needle in ["ultra", "low", "mid", "high", "fast", "balanced", "deep"] {
            assert!(text.contains(needle), "{uri}: {text}");
        }
    }
    assert!(
        mock.messages.lock().unwrap().is_empty(),
        "nothing reached the upstream"
    );
}

#[tokio::test]
async fn call_record_carries_estimate_ratio_and_upstream_id() {
    // priced_state: 1.0 / 2.0 per 1M tokens, so 1000 in + 500 out is 2000 micro-USD estimated.
    let dear = r#"{"id":"gen-abc123","type":"message","role":"assistant","content":[],"usage":{"input_tokens":1000,"output_tokens":500,"cost":0.0045}}"#;
    let near = r#"{"id":"gen-near","type":"message","role":"assistant","content":[],"usage":{"input_tokens":1000,"output_tokens":500,"cost":0.0024}}"#;
    let mock = spawn_mock(vec![json_reply(dear), json_reply(near)], JEV_LOW).await;
    let state = priced_state(mock.addr);
    let mut rows = Vec::new();
    for session in ["ratio-dear", "ratio-near"] {
        let response = send(
            &state,
            &session_turn(session),
            &[("x-octo-tier-hint", "fast"), ("x-octo-budget-key", session)],
        )
        .await;
        let id = hv(&response, "x-octo-request-id");
        let _ = body_json(response).await;
        let (status, row) = get(&state, &format!("/autoroute/v1/calls/{id}")).await;
        assert_eq!(status, StatusCode::OK);
        rows.push(row);
    }
    // reported wins for the charge; the ratio is 4500 / 2000 = 2.25
    assert_eq!(rows[0]["cost_usd"], 0.0045);
    assert_eq!(rows[0]["estimate_ratio"], 2.25);
    assert_eq!(rows[0]["upstream_id"], "gen-abc123");
    // within 25% of the estimate: no ratio
    assert_eq!(rows[1]["cost_usd"], 0.0024);
    assert!(rows[1].get("estimate_ratio").is_none(), "{}", rows[1]);
    assert_eq!(rows[1]["upstream_id"], "gen-near");
}

#[test]
fn estimate_ratio_needs_a_reported_cost_and_a_gap_over_25_percent() {
    use octo::history::{estimate_ratio, CostMicros, CostSource, ResolvedCost};
    let resolved = |cost: u64, estimated: Option<u64>, source| ResolvedCost {
        cost: Some(CostMicros(cost)),
        or_cost: None,
        upstream_cost: None,
        estimated_cost: estimated.map(CostMicros),
        source,
        is_byok: None,
        upstream_provider: None,
    };
    assert_eq!(
        estimate_ratio(&resolved(2500, Some(1000), CostSource::OpenRouter)),
        Some(2.5)
    );
    assert_eq!(
        estimate_ratio(&resolved(1400, Some(1000), CostSource::Upstream)),
        Some(1.4)
    );
    assert_eq!(
        estimate_ratio(&resolved(500, Some(1000), CostSource::OpenRouter)),
        Some(0.5)
    );
    assert_eq!(
        estimate_ratio(&resolved(1250, Some(1000), CostSource::OpenRouter)),
        None
    );
    assert_eq!(
        estimate_ratio(&resolved(800, Some(1000), CostSource::OpenRouter)),
        None
    );
    assert_eq!(
        estimate_ratio(&resolved(2500, None, CostSource::OpenRouter)),
        None
    );
    assert_eq!(
        estimate_ratio(&resolved(2500, Some(1000), CostSource::Estimate)),
        None,
        "an estimate is not compared with itself"
    );
}
