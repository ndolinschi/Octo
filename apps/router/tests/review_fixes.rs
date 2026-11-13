mod support;

use axum::http::{HeaderMap, HeaderValue};
use octo::auto::{
    decide_with, Auto, DecideRequest, Hints, RequestShape, SessionChoice, TierPolicy, Tiers, Turn,
};
use octo::history::{
    estimate_ratio, estimate_warn_due, resolve_cost, CostMicros, CostSource, History, ModelPrice,
    ParsedUsage, PriceTable, ResolvedCost, TokenCount,
};
use octo::providers::openrouter::{OpenRouterModel, OpenRouterModels};
use octo::proxy::autoroute::{escalation_blocked, EscalationShape};
use octo::proxy::stdin_watch;
use octo::state::AppState;
use serde_json::{json, Value};
use support::sample_config;

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

fn tiers_with(low: f64, mid: f64, high: f64) -> Tiers {
    let mut tiers = Tiers::new("low-model".into(), "mid-model".into(), "high-model".into());
    tiers.prices = PriceTable::new(vec![
        ("low-model".into(), price(low, low)),
        ("mid-model".into(), price(mid, mid)),
        ("high-model".into(), price(high, high)),
    ]);
    tiers
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

fn bulky_body(session: &str) -> Value {
    json!({
        "metadata": {"user_id": format!("{{\"session_id\":\"{session}\"}}")},
        "max_tokens": 1024,
        "tools": [{"name": "Read"}],
        "messages": [{"role": "user", "content": [{"type": "tool_result", "tool_use_id": "1", "content": "x".repeat(12_000)}]}]
    })
}

async fn decide(auto: &Auto, body: Value, hints: &Hints) -> Turn {
    let (history, client) = (History::disabled(), reqwest::Client::new());
    decide_with(
        DecideRequest {
            auto,
            history: &history,
            client: &client,
            decisions_url: "http://127.0.0.1:9/decisions",
            api_key: "",
            body,
            allow_compact: true,
        },
        hints,
    )
    .await
}

// ---- 1: the price swap respects context windows ----

async fn served_by(windows: (u64, u64, u64)) -> (String, Option<String>) {
    let auto = Auto::new(tiers_with(9.0, 5.0, 1.0));
    auto.seed_catalog(OpenRouterModels {
        free: Vec::new(),
        paid: vec![
            paid("low-model", windows.0),
            paid("mid-model", windows.1),
            paid("high-model", windows.2),
        ],
    })
    .await;
    auto.seed_session(
        "win-1",
        SessionChoice::fresh("low-model".into(), vec!["Read".into()], "low".into()),
    );
    let turn = decide(&auto, bulky_body("win-1"), &Hints::default()).await;
    let Turn::Forward(forward) = turn else {
        panic!("expected forward, got {turn:?}");
    };
    let body: Value = serde_json::from_slice(&forward.body).unwrap();
    (
        body["model"].as_str().unwrap().to_string(),
        forward.meta.decided_tier.clone(),
    )
}

#[tokio::test]
async fn the_price_swap_never_picks_a_tier_whose_window_cannot_hold_the_request() {
    // ~3000 tokens in, 1024 reserved: a 4000-token window cannot hold it, 100k can.
    let (model, decided) = served_by((100_000, 100_000, 4_000)).await;
    assert_eq!(model, "mid-model", "high is cheapest but too small");
    assert_eq!(decided.as_deref(), Some("low"));
    // control: every window fits, so the cheapest tier (high) wins
    let (model, decided) = served_by((100_000, 100_000, 100_000)).await;
    assert_eq!(model, "high-model");
    assert_eq!(decided.as_deref(), Some("low"));
    // nothing cheaper fits: the decided tier is served
    let (model, decided) = served_by((100_000, 4_000, 4_000)).await;
    assert_eq!(model, "low-model");
    assert!(decided.is_none());
}

// ---- 3: the compaction fallback respects ceiling and fixed ----

#[tokio::test]
async fn the_compaction_fallback_stays_under_a_ceiling_and_is_absent_under_fixed() {
    for (policy, label) in [
        (TierPolicy::Ceiling, "ceiling"),
        (TierPolicy::Fixed, "fixed"),
    ] {
        let auto = Auto::new(tiers_with(1.0, 5.0, 9.0));
        auto.seed_catalog(OpenRouterModels {
            free: Vec::new(),
            paid: vec![
                paid("low-model", 4_000),
                paid("mid-model", 8_000),
                paid("high-model", 16_000),
            ],
        })
        .await;
        auto.seed_session(
            "cmp-1",
            SessionChoice::fresh("low-model".into(), vec!["Read".into()], "low".into()),
        );
        let hints = Hints {
            tier: Some("low"),
            policy,
            ..Hints::default()
        };
        let turn = decide(&auto, bulky_body("cmp-1"), &hints).await;
        let Turn::Compact(compact) = turn else {
            panic!("{label}: expected compact, got {turn:?}");
        };
        assert_eq!(compact.model, "low-model", "{label}");
        assert_eq!(compact.fallback_model, None, "{label}");
    }
    // control: with no ceiling the request is upgraded instead of compacted
    let auto = Auto::new(tiers_with(1.0, 5.0, 9.0));
    auto.seed_catalog(OpenRouterModels {
        free: Vec::new(),
        paid: vec![
            paid("low-model", 4_000),
            paid("mid-model", 8_000),
            paid("high-model", 16_000),
        ],
    })
    .await;
    auto.seed_session(
        "cmp-2",
        SessionChoice::fresh("low-model".into(), vec!["Read".into()], "low".into()),
    );
    let turn = decide(&auto, bulky_body("cmp-2"), &Hints::default()).await;
    assert!(matches!(turn, Turn::Forward(_)), "{turn:?}");
}

// ---- 5: stdin watch ----

struct Script {
    steps: Vec<std::io::Result<usize>>,
}

impl std::io::Read for Script {
    fn read(&mut self, _buf: &mut [u8]) -> std::io::Result<usize> {
        if self.steps.is_empty() {
            return Ok(0);
        }
        self.steps.remove(0)
    }
}

fn kind(kind: std::io::ErrorKind) -> std::io::Result<usize> {
    Err(std::io::Error::from(kind))
}

#[test]
fn stdin_watch_survives_interrupts_and_would_block_and_stops_on_eof() {
    use std::io::ErrorKind::{Interrupted, WouldBlock};
    let started = std::time::Instant::now();
    let rx = stdin_watch::spawn(Script {
        steps: vec![
            kind(Interrupted),
            Ok(10),
            kind(WouldBlock),
            kind(Interrupted),
            kind(WouldBlock),
            Ok(3),
            Ok(0),
        ],
    });
    rx.blocking_recv().unwrap();
    assert!(
        started.elapsed() >= std::time::Duration::from_millis(100),
        "WouldBlock is polled, not treated as EOF"
    );
}

#[test]
fn stdin_watch_stops_on_a_hard_error() {
    let rx = stdin_watch::spawn(Script {
        steps: vec![Ok(1), kind(std::io::ErrorKind::BrokenPipe), Ok(5)],
    });
    rx.blocking_recv().unwrap();
}

// ---- 6: a partial price row is not priced ----

#[test]
fn a_partial_price_row_takes_no_part_in_the_price_rule() {
    let mut tiers = tiers_with(9.0, 5.0, 1.0);
    let mut partial = price(0.001, 0.0);
    partial.rates_complete = false;
    tiers.prices = PriceTable::new(vec![
        ("low-model".into(), price(9.0, 9.0)),
        ("mid-model".into(), price(5.0, 5.0)),
        ("high-model".into(), partial),
    ]);
    let shape = RequestShape::default();
    assert_eq!(tiers.blended_cost_micros("high", shape), None);
    assert_eq!(tiers.price_swap("low", None, shape), Some("mid"));
    assert_eq!(tiers.cheapest_band(shape), None);
}

// ---- 8: the budget check compares the tier the rule would serve ----

#[tokio::test]
async fn a_spent_budget_allows_an_escalation_the_rule_serves_at_the_cheapest_tier() {
    let mut config = sample_config(1024);
    config.autoroute_low_model = "low-model".into();
    config.autoroute_mid_model = "mid-model".into();
    config.autoroute_high_model = "high-model".into();
    config.prices = tiers_with(9.0, 5.0, 1.0).prices;
    let state = AppState::new(config).unwrap();
    let hints = Hints {
        budget_key: Some("proj".into()),
        budget_micros: Some(1_000),
        ..Hints::default()
    };
    state.auto.bind_hints(None, &hints);
    state
        .auto
        .charge(&History::disabled(), None, Some("proj"), 5_000);
    assert!(state.auto.budget_status(None, Some("proj")).is_some());
    let how = |swap| EscalationShape {
        shape: RequestShape::default(),
        swap,
    };
    // mid is decided, high (the cheapest) is served: allowed
    assert!(!escalation_blocked(
        &state,
        None,
        &hints,
        "mid-model",
        how(true)
    ));
    // without the swap mid itself would be served: refused
    assert!(escalation_blocked(
        &state,
        None,
        &hints,
        "mid-model",
        how(false)
    ));
}

// ---- 9: estimate ratio thresholds ----

fn resolved(cost: u64, estimated: u64, differs: bool) -> ResolvedCost {
    ResolvedCost {
        cost: Some(CostMicros(cost)),
        or_cost: None,
        upstream_cost: None,
        estimated_cost: Some(CostMicros(estimated)),
        source: CostSource::OpenRouter,
        is_byok: None,
        upstream_provider: None,
        estimate_basis_differs: differs,
    }
}

#[test]
fn estimate_ratio_ignores_tiny_estimates_and_a_different_served_model() {
    assert_eq!(estimate_ratio(&resolved(30, 10, false)), None, "tiny call");
    assert_eq!(estimate_ratio(&resolved(297, 99, false)), None, "below 100");
    assert_eq!(estimate_ratio(&resolved(300, 100, false)), Some(3.0));
    assert_eq!(
        estimate_ratio(&resolved(300, 100, true)),
        None,
        "other model"
    );
}

#[test]
fn the_estimate_comes_from_the_served_model_when_the_response_names_one() {
    let table = PriceTable::new(vec![
        ("asked/model".into(), price(1.0, 1.0)),
        ("served/model".into(), price(10.0, 10.0)),
    ]);
    let usage = |model: Option<&str>| ParsedUsage {
        input_tokens: Some(TokenCount(100_000)),
        output_tokens: Some(TokenCount(0)),
        cost: Some(CostMicros(1_000_000)),
        model: model.map(str::to_string),
        ..ParsedUsage::default()
    };
    let same = resolve_cost(&usage(None), Some("asked/model"), &table);
    assert_eq!(same.estimated_cost, Some(CostMicros(100_000)));
    assert!(!same.estimate_basis_differs);
    let other = resolve_cost(&usage(Some("served/model")), Some("asked/model"), &table);
    assert_eq!(other.estimated_cost, Some(CostMicros(1_000_000)));
    assert!(!other.estimate_basis_differs);
    assert_eq!(
        estimate_ratio(&other),
        None,
        "reported equals the served estimate"
    );
    let unknown = resolve_cost(&usage(Some("mystery/model")), Some("asked/model"), &table);
    assert!(unknown.estimate_basis_differs);
    assert_eq!(estimate_ratio(&unknown), None);
}

#[test]
fn the_ratio_warning_repeats_at_most_once_an_hour_per_model() {
    let mut last = std::collections::HashMap::new();
    let t0 = std::time::Instant::now();
    assert!(estimate_warn_due(&mut last, "a", t0));
    assert!(!estimate_warn_due(
        &mut last,
        "a",
        t0 + std::time::Duration::from_secs(3599)
    ));
    assert!(estimate_warn_due(
        &mut last,
        "b",
        t0 + std::time::Duration::from_secs(10)
    ));
    assert!(estimate_warn_due(
        &mut last,
        "a",
        t0 + std::time::Duration::from_secs(3600)
    ));
    assert!(!estimate_warn_due(
        &mut last,
        "a",
        t0 + std::time::Duration::from_secs(3601)
    ));
}

// ---- 10: undecodable and repeated tier hints ----

fn take(values: &[&[u8]]) -> Result<Hints, octo::auto::InvalidTierHint> {
    let mut headers = HeaderMap::new();
    for value in values {
        headers.append("x-octo-tier-hint", HeaderValue::from_bytes(value).unwrap());
    }
    let result = Hints::take(&mut headers);
    assert!(headers.is_empty(), "the header is always consumed");
    result
}

#[test]
fn an_undecodable_tier_hint_is_rejected_like_any_other_bad_value() {
    let err = take(&[&[0xff, 0xfe]]).unwrap_err();
    assert!(err.message().contains("visible ASCII"), "{}", err.message());
    assert!(take(&[b"ultra"]).is_err());
    assert_eq!(take(&[b"  "]).unwrap().tier, None, "empty stays ignored");
}

#[test]
fn repeated_tier_hints_must_all_be_valid_and_agree() {
    assert_eq!(take(&[b"fast", b"LOW"]).unwrap().tier, Some("low"));
    assert_eq!(take(&[b"deep"]).unwrap().tier, Some("high"));
    let err = take(&[b"fast", b"deep"]).unwrap_err();
    assert!(err.message().contains("conflicting"), "{}", err.message());
    assert!(take(&[b"fast", b"ultra"]).is_err());
    assert!(take(&[b"ultra", b"fast"]).is_err());
    assert!(take(&[b"fast", &[0xff]]).is_err());
}
