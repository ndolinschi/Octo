mod support;

use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::{
    body::{to_bytes, Body},
    http::{header, Request, Response, StatusCode},
};
use futures_util::future::BoxFuture;
use octo::auto::{RequestShape, Tiers};
use octo::config::Config;
use octo::history::{ModelPrice, PriceSource, PriceTable};
use octo::prices::{
    default_cache_path, jittered, load_cache, merge, parse_catalogue, resolve_mode, retry_delay,
    save_cache, CatalogueEntry, CatalogueSnapshot, CatalogueSource, FetchError, Fetched,
    ParseError, PriceBook, RefreshMode, Refresher,
};
use octo::providers::openrouter::OpenRouterModels;
use octo::routes;
use octo::state::AppState;
use serde_json::{json, Value};
use support::{sample_config, spawn_scripted_server, Scripted};
use tokio::sync::Notify;
use tower::ServiceExt;

const FIXTURE: &[u8] = include_bytes!("fixtures/openrouter_catalogue_2026-11-14.json");
const JEV_LOW: &str = r#"{"is_hard":{"noul":0.1},"is_easy":{"noul":0.9}}"#;
const DAY: u64 = 86_400;
/// 2026-11-14T00:00:00Z
const NOV_14: u64 = 1_794_614_400;

fn entry<'a>(entries: &'a [CatalogueEntry], id: &str) -> &'a CatalogueEntry {
    entries
        .iter()
        .find(|e| e.id == id)
        .unwrap_or_else(|| panic!("{id}"))
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

fn cat(id: &str, input: f64, output: f64) -> CatalogueEntry {
    CatalogueEntry {
        id: id.to_string(),
        canonical: None,
        input,
        cache_read: 0.0,
        cache_write: 0.0,
        output,
    }
}

fn snapshot(fetched_at: u64, models: Vec<CatalogueEntry>) -> CatalogueSnapshot {
    CatalogueSnapshot {
        fetched_at,
        etag: None,
        models,
    }
}

fn temp_dir(name: &str) -> PathBuf {
    static SEQ: AtomicUsize = AtomicUsize::new(0);
    let dir = std::env::temp_dir().join(format!(
        "octo-price-{name}-{}-{}",
        std::process::id(),
        SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

// ---- parser (fixture trimmed from a real GET https://openrouter.ai/api/v1/models on 2026-11-14) ----

#[test]
fn the_parser_reads_ladder_prices_per_million_tokens() {
    let (entries, stats) = parse_catalogue(FIXTURE).unwrap();
    let low = entry(&entries, "deepseek/deepseek-v4.1-flash");
    assert_eq!(
        (low.input, low.cache_read, low.cache_write, low.output),
        (0.0507, 0.001014, 0.0, 0.2028)
    );
    assert_eq!(
        low.canonical.as_deref(),
        Some("deepseek/deepseek-v4.1-flash-20260910")
    );
    let high = entry(&entries, "deepseek/deepseek-v4.1-flash-1017");
    assert_eq!(
        (high.input, high.cache_read, high.output),
        (0.038, 0.01, 0.5)
    );
    assert_eq!(stats.dynamic, 1, "typesafe/jev-router lists -1");
    assert_eq!(stats.malformed, 2);
    assert!(entries.iter().all(|e| e.id != "typesafe/jev-router"));
    assert!(entries.iter().all(|e| !e.id.starts_with("example/")));
}

#[test]
fn time_window_overrides_take_the_peak_and_token_overrides_are_ignored() {
    let (entries, _) = parse_catalogue(FIXTURE).unwrap();
    let mid = entry(&entries, "minimax/minimax-m3.1-flash");
    assert_eq!(
        (mid.input, mid.cache_read, mid.output),
        (0.15, 0.015, 0.6),
        "peak window, not the 0.075 / 0.30 base"
    );
    let qwen = entry(&entries, "qwen/qwen3.7-flash");
    assert_eq!(
        (qwen.input, qwen.cache_read, qwen.cache_write, qwen.output),
        (0.03, 0.006, 0.038, 0.13),
        "the base rate, not the >=32k-token rate"
    );
}

#[test]
fn free_models_and_cache_write_prices_are_kept() {
    let (entries, _) = parse_catalogue(FIXTURE).unwrap();
    let free = entry(&entries, "inclusionai/ling-3.2-flash:free");
    assert_eq!((free.input, free.output), (0.0, 0.0));
    let gemini = entry(&entries, "google/gemini-4-hydrogen");
    assert_eq!(gemini.cache_write, 0.083333333);
}

#[test]
fn the_parser_rejects_bad_bodies() {
    assert!(matches!(
        parse_catalogue(b"<html>"),
        Err(ParseError::Json(_))
    ));
    assert_eq!(
        parse_catalogue(br#"{"models":[]}"#),
        Err(ParseError::NoData)
    );
    assert_eq!(
        parse_catalogue(br#"{"data":[{"id":"a/b","pricing":{"prompt":"-1","completion":"-1"}}]}"#),
        Err(ParseError::Empty)
    );
    let numbers = parse_catalogue(
        br#"{"data":[{"id":"a/b","pricing":{"prompt":0.000001,"completion":2e-6,"input_cache_read":null}}]}"#,
    )
    .unwrap()
    .0;
    assert_eq!((numbers[0].input, numbers[0].output), (1.0, 2.0));
}

// ---- precedence ----

fn file_table() -> PriceTable {
    let mut billed = price(0.3, 1.2);
    billed.billed_as = Some("invoice-name".into());
    PriceTable::with_sources(vec![
        ("manual/model".into(), price(9.0, 9.0), PriceSource::Manual),
        ("both/model".into(), billed, PriceSource::Fallback),
        (
            "only-file/model".into(),
            price(2.0, 2.0),
            PriceSource::Fallback,
        ),
    ])
}

fn catalogue() -> CatalogueSnapshot {
    let mut both = cat("both/model", 0.1, 0.2);
    both.canonical = Some("both/model-20261001".into());
    let mut manual = cat("manual/model", 1.0, 1.0);
    manual.canonical = Some("manual/model-20261001".into());
    snapshot(NOV_14, vec![both, manual, cat("only-cat/model", 0.5, 0.5)])
}

#[test]
fn manual_beats_catalogue_beats_fallback() {
    let table = merge(&file_table(), Some(&catalogue()));
    let at = PriceSource::Catalogue { fetched_at: NOV_14 };
    let (manual, source) = table.get_with_source("manual/model").unwrap();
    assert_eq!((manual.input, source), (9.0, PriceSource::Manual));
    let (both, source) = table.get_with_source("both/model").unwrap();
    assert_eq!((both.input, source), (0.1, at));
    assert_eq!(both.billed_as.as_deref(), Some("invoice-name"));
    let (file, source) = table.get_with_source("only-file/model").unwrap();
    assert_eq!((file.input, source), (2.0, PriceSource::Fallback));
    assert_eq!(table.source("only-cat/model"), Some(at));
    assert!(table.get("unknown/model").is_none());
}

#[test]
fn canonical_slugs_resolve_and_a_manual_row_covers_them() {
    let table = merge(&file_table(), Some(&catalogue()));
    assert_eq!(table.get("both/model-20261001").unwrap().input, 0.1);
    assert_eq!(
        table.get("~both/model").unwrap().input,
        0.1,
        "markers are ignored"
    );
    assert!(
        table.get("manual/model-20261001").is_none(),
        "the catalogue row of a manual model is not used under its canonical slug either"
    );
}

#[test]
fn without_a_catalogue_the_file_rows_apply() {
    let table = merge(&file_table(), None);
    assert_eq!(table.source("manual/model"), Some(PriceSource::Manual));
    assert_eq!(table.source("both/model"), Some(PriceSource::Fallback));
    assert_eq!(table.len(), 3);
}

#[test]
fn price_source_labels_name_the_catalogue_date() {
    assert_eq!(PriceSource::Manual.label(), "manual");
    assert_eq!(PriceSource::Fallback.label(), "fallback");
    assert_eq!(
        PriceSource::Catalogue {
            fetched_at: NOV_14 + 3600
        }
        .label(),
        "catalogue@2026-11-14"
    );
    assert_eq!(
        octo::history::utc_timestamp(NOV_14 + 3661),
        "2026-11-14T01:01:01Z"
    );
}

// ---- prices.toml schema ----

fn config_dir(prices: &str) -> PathBuf {
    let dir = temp_dir("config");
    std::fs::write(
        dir.join("server.toml"),
        "[server]\nbind_addr = \"127.0.0.1:0\"\n",
    )
    .unwrap();
    std::fs::write(dir.join("limits.toml"), "[limits]\nmax_body_bytes = 1024\n").unwrap();
    std::fs::write(dir.join("prices.toml"), prices).unwrap();
    dir
}

#[test]
fn a_source_manual_row_is_an_override_and_other_rows_are_fallback() {
    let dir = config_dir(
        r#"
[prices]
refresh = "off"
refresh_interval_secs = 3600
cache_file = "/tmp/x.json"

[prices."a/manual"]
source = "manual"
input = 1.0
cache_read = 0.0
cache_write = 0.0
output = 2.0

[prices."a/plain"]
input = 1.0
cache_read = 0.0
cache_write = 0.0
output = 2.0
"#,
    );
    let config = Config::load_from_directory(&dir).unwrap();
    assert_eq!(config.prices.source("a/manual"), Some(PriceSource::Manual));
    assert_eq!(config.prices.source("a/plain"), Some(PriceSource::Fallback));
    assert_eq!(config.price_refresh.refresh, Some(RefreshMode::Off));
    assert_eq!(config.price_refresh.interval_secs, 3600);
    assert_eq!(
        config.price_refresh.cache_file.as_deref(),
        Some("/tmp/x.json")
    );
}

#[test]
fn the_shipped_prices_toml_is_all_fallback_with_default_refresh_settings() {
    let dir = temp_dir("shipped");
    std::fs::write(
        dir.join("server.toml"),
        "[server]\nbind_addr = \"127.0.0.1:0\"\n",
    )
    .unwrap();
    std::fs::write(dir.join("limits.toml"), "[limits]\nmax_body_bytes = 1024\n").unwrap();
    let config = Config::load_from_directory(&dir).unwrap();
    assert!(!config.prices.is_empty());
    assert!(config
        .prices
        .rows()
        .all(|(_, _, source)| source == PriceSource::Fallback));
    assert_eq!(
        config.price_refresh,
        octo::prices::RefreshSettings::default()
    );
    assert_eq!(config.price_refresh.interval_secs, 6 * 3600);
}

#[test]
fn bad_price_settings_fail_the_load() {
    for bad in [
        "[prices]\nrefresh = \"sometimes\"\n",
        "[prices]\nunknown = 1\n",
        "[prices.\"a/b\"]\nsource = \"guess\"\ninput = 1.0\n",
    ] {
        let dir = config_dir(bad);
        assert!(Config::load_from_directory(&dir).is_err(), "{bad}");
    }
}

// ---- mode ----

#[test]
fn refresh_mode_defaults_by_upstream_and_the_env_var_wins() {
    let real = [
        "https://openrouter.ai/api/v1/messages",
        "https://openrouter.ai/api/v1/chat/completions",
        "https://openrouter.ai/api/alpha/decisions",
    ];
    let mock = [
        "http://127.0.0.1:8812/v1/messages",
        "https://openrouter.ai/api/v1/chat/completions",
        "https://openrouter.ai/api/alpha/decisions",
    ];
    assert_eq!(resolve_mode(None, None, &real).0, RefreshMode::Catalogue);
    assert_eq!(resolve_mode(None, None, &mock).0, RefreshMode::Off);
    assert!(resolve_mode(None, None, &mock).1.contains("127.0.0.1:8812"));
    assert_eq!(
        resolve_mode(Some(RefreshMode::Catalogue), None, &mock).0,
        RefreshMode::Catalogue
    );
    assert_eq!(
        resolve_mode(Some(RefreshMode::Off), None, &real).0,
        RefreshMode::Off
    );
    assert_eq!(
        resolve_mode(Some(RefreshMode::Catalogue), Some("off"), &real).0,
        RefreshMode::Off
    );
    assert_eq!(
        resolve_mode(None, Some("catalogue"), &mock).0,
        RefreshMode::Catalogue
    );
    assert_eq!(resolve_mode(None, Some("bogus"), &real).0, RefreshMode::Off);
    assert_eq!(
        resolve_mode(None, Some(""), &real).0,
        RefreshMode::Catalogue,
        "an empty env var is unset"
    );
}

#[test]
fn off_mode_starts_nothing_and_health_says_so() {
    let config = sample_config(1024);
    let state = AppState::new(config.clone()).unwrap();
    assert_eq!(state.prices.status().mode, RefreshMode::Off);
    assert!(octo::prices::start(&config, &state.prices, state.auto.tiers()).is_none());
    let health = state.prices.health_json(NOV_14);
    assert_eq!(health["refresh"], "off");
    assert!(health["catalogue"].is_null());
}

// ---- disk cache ----

#[test]
fn the_cache_round_trips_and_lives_beside_the_history_database() {
    let dir = temp_dir("cache");
    let path = dir.join("prices-catalogue.json");
    assert!(load_cache(&path).is_none());
    let mut saved = catalogue();
    saved.etag = Some("\"abc\"".into());
    save_cache(&path, &saved).unwrap();
    assert_eq!(load_cache(&path), Some(saved));
    std::fs::write(&path, "{not json").unwrap();
    assert!(load_cache(&path).is_none());
    assert_eq!(
        default_cache_path("data/history.sqlite"),
        Some(PathBuf::from("data/prices-catalogue.json"))
    );
    assert_eq!(
        default_cache_path("/var/octo/history.sqlite"),
        Some(PathBuf::from("/var/octo/prices-catalogue.json"))
    );
    assert_eq!(
        default_cache_path("history.sqlite"),
        Some(PathBuf::from("prices-catalogue.json"))
    );
    assert_eq!(default_cache_path("sqlite::memory:"), None);
}

#[test]
fn a_restart_without_network_uses_the_cache_and_shows_its_age() {
    let dir = temp_dir("restart");
    let path = dir.join("prices-catalogue.json");
    let old = NOV_14 - 3 * DAY;
    save_cache(&path, &snapshot(old, vec![cat("x/model", 1.0, 2.0)])).unwrap();
    let book = PriceBook::new(
        PriceTable::default(),
        RefreshMode::Catalogue,
        "test".into(),
        6 * 3600,
    );
    let refresher = Refresher::new(
        book.clone(),
        PriceTable::default(),
        Arc::new(Fake::failing()),
        Some(path),
        Duration::from_secs(6 * 3600),
    );
    let report = refresher.load_cache().unwrap();
    assert_eq!(report.added, 1);
    assert_eq!(
        book.live().snapshot().source("x/model"),
        Some(PriceSource::Catalogue { fetched_at: old })
    );
    assert!(book.stale(NOV_14));
    assert!(!book.stale(old + 3600));
    let health = book.health_json(NOV_14);
    assert_eq!(health["catalogue"]["stale"], true);
    assert_eq!(health["catalogue"]["from_cache"], true);
    assert_eq!(health["catalogue"]["age_secs"], 3 * DAY);
    assert_eq!(health["catalogue"]["fetched_at"], "2026-11-11T00:00:00Z");
}

// ---- refresher with a fake source ----

#[derive(Default)]
struct Fake {
    responses: Mutex<Vec<Result<Fetched, String>>>,
    etags: Mutex<Vec<Option<String>>>,
    gate: Option<Arc<Notify>>,
}

impl Fake {
    fn with(responses: Vec<Result<Fetched, String>>) -> Self {
        Self {
            responses: Mutex::new(responses.into_iter().rev().collect()),
            ..Self::default()
        }
    }

    fn failing() -> Self {
        Self::with(vec![])
    }
}

impl CatalogueSource for Fake {
    fn fetch<'a>(&'a self, etag: Option<&'a str>) -> BoxFuture<'a, Result<Fetched, FetchError>> {
        Box::pin(async move {
            self.etags.lock().unwrap().push(etag.map(str::to_string));
            if let Some(gate) = &self.gate {
                gate.notified().await;
            }
            match self.responses.lock().unwrap().pop() {
                Some(Ok(fetched)) => Ok(fetched),
                Some(Err(message)) => Err(FetchError::Other(message)),
                None => Err(FetchError::Status(503)),
            }
        })
    }
}

fn body(models: Value, etag: Option<&str>) -> Result<Fetched, String> {
    Ok(Fetched::Body {
        bytes: serde_json::to_vec(&json!({ "data": models })).unwrap(),
        etag: etag.map(str::to_string),
    })
}

fn model(id: &str, input: &str, output: &str) -> Value {
    json!({"id": id, "pricing": {"prompt": input, "completion": output}})
}

#[tokio::test]
async fn a_refresh_applies_saves_and_reports_the_biggest_change() {
    let dir = temp_dir("refresh");
    let path = dir.join("prices-catalogue.json");
    let fake = Arc::new(Fake::with(vec![
        body(
            json!([
                model("both/model", "0.0000001", "0.0000002"),
                model("new/model", "0.000001", "0.000001")
            ]),
            Some("\"v1\""),
        ),
        Ok(Fetched::NotModified),
        Err("offline".into()),
    ]));
    let book = PriceBook::new(
        merge(&file_table(), None),
        RefreshMode::Catalogue,
        "test".into(),
        3600,
    );
    let refresher = Refresher::new(
        book.clone(),
        file_table(),
        fake.clone(),
        Some(path.clone()),
        Duration::from_secs(3600),
    );
    let report = refresher.refresh_once().await.unwrap();
    assert_eq!((report.models, report.updated, report.added), (2, 1, 1));
    assert_eq!(
        report.biggest.as_deref(),
        Some("both/model output 1.2 -> 0.2")
    );
    assert_eq!(book.live().snapshot().get("both/model").unwrap().input, 0.1);
    assert_eq!(load_cache(&path).unwrap().etag.as_deref(), Some("\"v1\""));

    let unchanged = refresher.refresh_once().await.unwrap();
    assert!(unchanged.not_modified);
    assert_eq!(unchanged.updated, 0);
    assert_eq!(
        fake.etags.lock().unwrap().last().unwrap().as_deref(),
        Some("\"v1\""),
        "the second fetch is conditional"
    );

    assert!(refresher.refresh_once().await.is_err());
    assert_eq!(
        book.live().snapshot().get("both/model").unwrap().input,
        0.1,
        "a failed fetch keeps the prices in use"
    );
    let status = book.status();
    assert_eq!(status.last_error.as_deref(), Some("offline"));
    assert!(!status.from_cache);
}

#[tokio::test]
async fn a_body_that_does_not_parse_changes_nothing() {
    let fake = Arc::new(Fake::with(vec![Ok(Fetched::Body {
        bytes: b"{\"data\":[]}".to_vec(),
        etag: None,
    })]));
    let book = PriceBook::new(
        merge(&file_table(), None),
        RefreshMode::Catalogue,
        "test".into(),
        3600,
    );
    let refresher = Refresher::new(
        book.clone(),
        file_table(),
        fake,
        None,
        Duration::from_secs(3600),
    );
    assert!(refresher.refresh_once().await.is_err());
    assert_eq!(*book.live().snapshot(), merge(&file_table(), None));
    assert!(book.status().fetched_at.is_none());
}

#[test]
fn retries_back_off_and_the_interval_is_jittered() {
    let six_hours = Duration::from_secs(6 * 3600);
    assert_eq!(retry_delay(1, six_hours), Duration::from_secs(60));
    assert_eq!(retry_delay(2, six_hours), Duration::from_secs(120));
    assert_eq!(retry_delay(4, six_hours), Duration::from_secs(480));
    assert_eq!(retry_delay(30, six_hours), Duration::from_secs(3600));
    assert_eq!(
        retry_delay(30, Duration::from_secs(600)),
        Duration::from_secs(600)
    );
    let mut seen = std::collections::HashSet::new();
    for seed in 0..200u64 {
        let wait = jittered(six_hours, seed);
        assert!(wait >= six_hours.mul_f64(0.9) && wait <= six_hours.mul_f64(1.1));
        seen.insert(wait);
    }
    assert!(seen.len() > 50, "jitter spreads the refreshes");
}

// ---- the router: refresh does not block, the price rule reads the live table ----

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

fn hv(response: &Response<Body>, name: &str) -> Option<String> {
    response
        .headers()
        .get(name)
        .map(|value| value.to_str().unwrap().to_string())
}

async fn get_json(state: &AppState, uri: &str) -> Value {
    let response = routes::router(state.clone())
        .oneshot(Request::builder().uri(uri).body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap()).unwrap()
}

async fn call_row(state: &AppState, response: Response<Body>) -> Value {
    let id = hv(&response, "x-octo-request-id").unwrap();
    let _ = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    get_json(state, &format!("/autoroute/v1/calls/{id}")).await
}

/// The ladder is inverted by the prices.toml table (high cheapest), ordered by the catalogue.
fn inverted_file() -> PriceTable {
    PriceTable::new(vec![
        ("low-model".into(), price(9.0, 9.0)),
        ("mid-model".into(), price(5.0, 5.0)),
        ("high-model".into(), price(1.0, 1.0)),
    ])
}

fn ordered_catalogue(fetched_at: u64) -> CatalogueSnapshot {
    snapshot(
        fetched_at,
        vec![
            cat("low-model", 1.0, 1.0),
            cat("mid-model", 5.0, 5.0),
            cat("high-model", 9.0, 9.0),
        ],
    )
}

const USAGE_REPLY: &str = r#"{"type":"message","role":"assistant","content":[],"usage":{"input_tokens":1000,"output_tokens":1000}}"#;

async fn ladder_state(messages: usize, decisions: usize) -> AppState {
    let (addr, _) = spawn_scripted_server(
        "/v1/messages",
        vec![Scripted::ok().with_body(USAGE_REPLY); messages],
    )
    .await;
    let (jev, _) = spawn_scripted_server(
        "/v1/decisions",
        vec![Scripted::ok().with_body(JEV_LOW); decisions],
    )
    .await;
    let mut config = sample_config(256 * 1024);
    config.openrouter_messages_url = format!("http://{addr}/v1/messages");
    config.openrouter_decisions_url = format!("http://{jev}/v1/decisions");
    config.llm_messages_backend = "openrouter".to_string();
    config.autoroute_low_model = "low-model".into();
    config.autoroute_mid_model = "mid-model".into();
    config.autoroute_high_model = "high-model".into();
    config.prices = inverted_file();
    let state = AppState::new(config).unwrap();
    state.auto.seed_catalog(OpenRouterModels::default()).await;
    state
}

#[test]
fn the_tiers_hold_the_live_table_not_a_copy() {
    let book = PriceBook::new(inverted_file(), RefreshMode::Off, "test".into(), 3600);
    let mut tiers = Tiers::new("low-model".into(), "mid-model".into(), "high-model".into());
    tiers.prices = book.live();
    let copy = tiers.clone();
    assert_eq!(
        tiers.price_swap("low", None, RequestShape::default()),
        Some("high")
    );
    book.live()
        .replace(merge(&inverted_file(), Some(&ordered_catalogue(NOV_14))));
    assert_eq!(tiers.price_swap("low", None, RequestShape::default()), None);
    assert_eq!(copy.price_swap("low", None, RequestShape::default()), None);
}

#[tokio::test]
async fn a_refresh_mid_session_keeps_the_sticky_tier_and_changes_only_the_served_model() {
    let state = ladder_state(3, 1).await;
    let auth = [("authorization", "Bearer sk-test")];

    let first = send(&state, &turn("sticky-1"), &auth).await;
    assert_eq!(hv(&first, "x-octo-trigger").as_deref(), Some("classify"));
    assert_eq!(hv(&first, "x-octo-model").as_deref(), Some("high-model"));
    assert_eq!(hv(&first, "x-octo-decided-tier").as_deref(), Some("low"));
    let row = call_row(&state, first).await;
    assert_eq!(row["price_source"], "fallback", "{row}");

    let refresher = Refresher::new(
        state.prices.clone(),
        state.config.prices.clone(),
        Arc::new(Fake::failing()),
        None,
        Duration::from_secs(3600),
    )
    .with_ladder(state.auto.tiers().clone());
    let report = refresher.apply(ordered_catalogue(NOV_14), false);
    let (before, after) = report.rule_changed.expect("the price rule mapping changed");
    assert_eq!(before, "low->high, mid->high, high->high");
    assert_eq!(after, "low->low, mid->mid, high->high");

    let hold = send(&state, &tool_result_turn("sticky-1"), &auth).await;
    assert_eq!(hv(&hold, "x-octo-model").as_deref(), Some("low-model"));
    assert_eq!(hv(&hold, "x-octo-tier").as_deref(), Some("low"));
    assert!(hv(&hold, "x-octo-decided-tier").is_none());
    let row = call_row(&state, hold).await;
    assert_eq!(row["price_source"], "catalogue@2026-11-14", "{row}");
    assert_eq!(row["cost_source"], "estimated", "{row}");
    let remembered = state.auto.session_snapshot("sticky-1").unwrap();
    assert_eq!(
        remembered.sticky_band, "low",
        "the refresh did not move the session"
    );
    assert_eq!(remembered.model, "low-model");

    // Back to the inverted prices: the same session is swapped again, still decided low.
    refresher.apply(
        snapshot(
            NOV_14 + DAY,
            vec![
                cat("low-model", 9.0, 9.0),
                cat("mid-model", 5.0, 5.0),
                cat("high-model", 1.0, 1.0),
            ],
        ),
        false,
    );
    let again = send(&state, &tool_result_turn("sticky-1"), &auth).await;
    assert_eq!(hv(&again, "x-octo-model").as_deref(), Some("high-model"));
    assert_eq!(hv(&again, "x-octo-decided-tier").as_deref(), Some("low"));
    assert_eq!(
        state.auto.session_snapshot("sticky-1").unwrap().sticky_band,
        "low"
    );
}

#[tokio::test]
async fn requests_are_served_with_the_fallback_table_while_the_first_fetch_hangs() {
    let state = ladder_state(2, 0).await;
    let gate = Arc::new(Notify::new());
    let fake = Fake {
        responses: Mutex::new(vec![body(
            json!([
                model("low-model", "0.000001", "0.000001"),
                model("mid-model", "0.000005", "0.000005"),
                model("high-model", "0.000009", "0.000009")
            ]),
            None,
        )]),
        etags: Mutex::new(Vec::new()),
        gate: Some(gate.clone()),
    };
    let task = Refresher::new(
        state.prices.clone(),
        state.config.prices.clone(),
        Arc::new(fake),
        None,
        Duration::from_secs(3600),
    )
    .spawn();

    let hint = [("x-octo-tier-hint", "fast")];
    let during = tokio::time::timeout(Duration::from_secs(5), send(&state, &turn("nb-1"), &hint))
        .await
        .expect("a pending catalogue fetch does not hold up requests");
    assert_eq!(hv(&during, "x-octo-model").as_deref(), Some("high-model"));
    let health = get_json(&state, "/health").await;
    assert!(health["prices"]["catalogue"].is_null(), "{health}");
    assert!(!health["prices"]["last_attempt_at"].is_null(), "{health}");

    gate.notify_one();
    for _ in 0..200 {
        if state.prices.status().fetched_at.is_some() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let after = send(&state, &turn("nb-2"), &hint).await;
    assert_eq!(hv(&after, "x-octo-model").as_deref(), Some("low-model"));
    let health = get_json(&state, "/health").await;
    assert_eq!(health["prices"]["catalogue"]["models"], 3, "{health}");
    assert_eq!(health["prices"]["rows"]["catalogue"], 3, "{health}");
    task.abort();
}
