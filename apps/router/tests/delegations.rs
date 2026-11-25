mod support;

use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use axum::{
    body::{to_bytes, Body},
    extract::Request,
    http::{header, Request as HttpRequest, StatusCode},
    routing::post,
    Router,
};
use octo::auto::{
    derive_label, AgentSignal, DelegationClassifier, FinishStatus, OutcomeEvent, OutcomeReport,
    Solved, TestsReport,
};
use octo::history::{History, ModelPrice, PriceTable, SessionOutcome};
use octo::routes;
use octo::state::AppState;
use serde_json::{json, Value};
use support::sample_config;
use tokio::net::TcpListener;
use tower::ServiceExt;

const EASY: &str = r#"{"is_hard":{"noul":0.1},"is_easy":{"noul":0.9}}"#;
const AUTH: (&str, &str) = ("authorization", "Bearer sk-test");

fn temp_db(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "octo-delegations-{name}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir.join("history.sqlite")
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

fn config() -> octo::config::Config {
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

async fn boot_with(config: octo::config::Config, db: &Path, store_payloads: bool) -> AppState {
    let mut state = AppState::new(config).unwrap();
    state.history = History::connect(db.to_str().unwrap(), "test-key", 256 * 1024)
        .await
        .unwrap()
        .with_store_payloads(store_payloads);
    state
}

async fn boot(name: &str, store_payloads: bool) -> (AppState, PathBuf) {
    let db = temp_db(name);
    (boot_with(config(), &db, store_payloads).await, db)
}

struct Classifier {
    addr: SocketAddr,
    hits: Arc<Mutex<usize>>,
}

async fn spawn_classifier(reply: &'static str) -> Classifier {
    let hits = Arc::new(Mutex::new(0));
    let counted = hits.clone();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let app = Router::new().route(
        "/v1/decisions",
        post(move |_request: Request| {
            let counted = counted.clone();
            async move {
                *counted.lock().unwrap() += 1;
                ([(header::CONTENT_TYPE, "application/json")], reply)
            }
        }),
    );
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    Classifier { addr, hits }
}

async fn call(
    state: &AppState,
    method: &str,
    uri: &str,
    headers: &[(&str, &str)],
    body: &Value,
) -> (StatusCode, Value) {
    let mut builder = HttpRequest::builder()
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
    let response = routes::router(state.clone())
        .oneshot(builder.body(body).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

fn api(id: &str, tier: &str) -> Value {
    json!({"id": id, "kind": "api", "tier": tier})
}

fn ladder() -> Vec<Value> {
    vec![
        api("fast", "fast"),
        api("balanced", "balanced"),
        api("deep", "deep"),
    ]
}

fn request(brief: &str) -> Value {
    json!({
        "budget_key": "proj-1",
        "session_id": "sess-1",
        "task": {"title": "Fix the parser", "brief": brief, "tools": ["read_file", "edit_file"], "depth": 1,
                 "parent_tier": "balanced"},
        "candidates": ladder()
    })
}

async fn route(state: &AppState, body: &Value) -> Value {
    let (status, value) = call(state, "POST", "/autoroute/v1/route", &[], body).await;
    assert_eq!(status, StatusCode::OK, "{value}");
    value
}

async fn outcome(state: &AppState, id: &str, body: Value) -> (StatusCode, Value) {
    call(
        state,
        "POST",
        &format!("/autoroute/v1/route/{id}/outcome"),
        &[],
        &body,
    )
    .await
}

fn finished(report_id: &str, status: &str) -> Value {
    json!({
        "report_id": report_id, "event": "finished", "status": status, "agent_signal": "done",
        "session_id": "child-1", "duration_ms": 1200,
        "usage": {"turns": 3, "tool_calls": 2, "failed_tool_calls": 0, "input_tokens": 900,
                  "output_tokens": 120, "cost_usd": 0.0042, "cost_estimated": false}
    })
}

async fn stored(state: &AppState, id: &str) -> octo::history::StoredDelegation {
    state.history.drain().await;
    state
        .history
        .delegation(id)
        .await
        .unwrap()
        .expect("delegation row")
}

#[tokio::test]
async fn a_route_decision_leaves_a_delegation_record_with_the_task_and_the_decision() {
    let (state, _db) = boot("record", true).await;
    let decided = route(&state, &request("Make the parser accept trailing commas.")).await;
    let id = decided["request_id"].as_str().unwrap();
    assert_eq!(
        decided["classifier"], "heuristic",
        "no API key: heuristic fallback"
    );
    assert_eq!(decided["attempt"], 1);
    let row = stored(&state, id).await;
    assert_eq!(row.budget_key, "proj-1");
    assert_eq!(row.session_id.as_deref(), Some("sess-1"));
    assert_eq!(row.title.as_deref(), Some("Fix the parser"));
    assert_eq!(
        row.brief.as_deref(),
        Some("Make the parser accept trailing commas.")
    );
    assert_eq!(row.brief_chars, 39);
    assert_eq!(row.brief_tokens, 10);
    assert_eq!(row.brief_hash.len(), 64);
    assert_eq!(row.tools, vec!["read_file", "edit_file"]);
    assert_eq!(row.depth, 1);
    assert_eq!(row.parent_tier.as_deref(), Some("balanced"));
    assert_eq!(row.candidates.as_array().unwrap().len(), 3);
    assert_eq!(row.choice, decided["choice"].as_str().unwrap());
    assert_eq!(row.choice_kind, "api");
    assert_eq!(row.band, decided["band"].as_str().unwrap());
    assert_eq!(row.reason, decided["reason"].as_str().unwrap());
    assert_eq!(row.classifier, "heuristic");
    assert_eq!(row.classifier_requested, "jev");
    assert_eq!(row.classifier_version, "heuristic-v1");
    assert_eq!(row.classifier_status, "fallback");
    assert_eq!(row.fallback_reason.as_deref(), Some("no API key"));
    assert_eq!(row.probabilities, None);
    assert!(row.estimated_cost_micros.is_some());
    assert_eq!(row.solved, "unknown");
    assert_eq!(row.solved_rule, "no_outcome");
    assert_eq!(row.text_features["tests"], false);
}

#[tokio::test]
async fn without_store_payloads_only_derived_features_of_the_text_are_kept() {
    let (state, _db) = boot("redact", false).await;
    let brief = "Update src/a.rs and src/b.rs so the tests pass.";
    let first = route(&state, &request(brief)).await;
    let second = route(&state, &request(brief)).await;
    let row = stored(&state, first["request_id"].as_str().unwrap()).await;
    assert_eq!(row.title, None);
    assert_eq!(row.brief, None);
    assert_eq!(row.title_chars, 14);
    assert_eq!(row.brief_chars, brief.chars().count() as u64);
    assert_eq!(row.text_features["multiple_files"], true);
    assert_eq!(row.text_features["tests"], true);
    let again = stored(&state, second["request_id"].as_str().unwrap()).await;
    assert_eq!(row.brief_hash, again.brief_hash, "equal briefs hash alike");
    assert_ne!(row.brief_hash, "");
}

#[tokio::test]
async fn an_outcome_is_stored_once_and_labels_the_delegation() {
    let (state, _db) = boot("outcome", true).await;
    let id = route(&state, &request("Rename foo to bar.")).await["request_id"]
        .as_str()
        .unwrap()
        .to_string();
    state.history.drain().await;
    let (status, value) = outcome(&state, &id, finished("r-1", "completed")).await;
    assert_eq!(status, StatusCode::OK, "{value}");
    assert_eq!(value["stored"], true);
    assert_eq!(value["solved"], "yes");
    assert_eq!(value["rule"], "completed");
    assert_eq!(value["confidence"], "low");
    let (status, again) = outcome(&state, &id, finished("r-1", "completed")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(again["stored"], false, "same report_id is idempotent");
    assert_eq!(again["reports"], 1);

    let (status, value) = outcome(
        &state,
        &id,
        json!({"report_id": "r-2", "event": "reverted"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{value}");
    assert_eq!(value["solved"], "no");
    assert_eq!(value["rule"], "undone");
    let row = stored(&state, &id).await;
    assert_eq!(row.solved, "no");
    assert_eq!(row.solved_rule, "undone");
    assert!(row.outcome_at.is_some());

    let (status, read) = call(
        &state,
        "GET",
        &format!("/autoroute/v1/route/{id}/outcome"),
        &[],
        &Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(read["reports"].as_array().unwrap().len(), 2);
    assert_eq!(read["solved"], "no");
}

#[tokio::test]
async fn the_label_reads_the_routers_own_test_summary_of_the_sub_agent_session() {
    let (state, _db) = boot("tests", true).await;
    let id = route(&state, &request("Fix the failing test.")).await["request_id"]
        .as_str()
        .unwrap()
        .to_string();
    state.history.drain().await;
    sqlx::query(
        "INSERT INTO session_outcomes (session_id, updated_at, last_test_tool, tests_passed, tests_failed, tests_errors, last_status) VALUES ('child-1', 1, 'cargo', 3, 1, 0, 'fail')",
    )
    .execute(state.history.pool().unwrap())
    .await
    .unwrap();
    let (_, value) = outcome(&state, &id, finished("r-1", "completed")).await;
    assert_eq!(value["solved"], "no");
    assert_eq!(value["rule"], "tests_failed");
}

#[tokio::test]
async fn outcome_errors_never_store_anything() {
    let (state, _db) = boot("errors", true).await;
    let (status, _) = outcome(&state, "octo_missing", finished("r", "completed")).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _) = outcome(
        &state,
        "octo_x",
        json!({"report_id": "r", "event": "finished"}),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::UNPROCESSABLE_ENTITY,
        "finished needs a status"
    );
    let (status, _) = outcome(&state, "octo_x", json!({"event": "nonsense"})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    let disabled = AppState::new(config()).unwrap();
    let (status, _) = outcome(&disabled, "octo_x", finished("r", "completed")).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
}

#[tokio::test]
async fn the_outcome_endpoint_requires_the_client_key() {
    let mut config = config();
    config.client_auth_key = "secret".to_string();
    let state = boot_with(config, &temp_db("auth"), true).await;
    let (status, _) = outcome(&state, "octo_x", finished("r", "completed")).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (status, _) = call(
        &state,
        "POST",
        "/autoroute/v1/route/octo_x/outcome",
        &[("x-octo-key", "secret")],
        &finished("r", "completed"),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "authenticated, unknown id");
}

#[tokio::test]
async fn health_advertises_route_outcome() {
    let state = AppState::new(config()).unwrap();
    let (_, value) = call(&state, "GET", "/health", &[], &Value::Null).await;
    assert!(value["capabilities"]
        .as_array()
        .unwrap()
        .contains(&json!("route_outcome")));
}

#[tokio::test]
async fn an_escalation_excludes_the_failed_candidate_and_asks_for_a_stronger_tier() {
    let (state, _db) = boot("escalate", true).await;
    let first = route(&state, &request("Rename foo to bar.")).await;
    assert_eq!(first["choice"], "fast");
    let mut retry = request("Rename foo to bar.");
    retry["attempt"] = json!(2);
    retry["escalated_from"] = first["request_id"].clone();
    retry["exclude"] = json!(["fast"]);
    retry["min_tier"] = json!("balanced");
    let second = route(&state, &retry).await;
    assert_eq!(second["choice"], "balanced");
    assert_eq!(second["band"], "medium", "band raised to the floor");
    assert_eq!(second["attempt"], 2);
    assert!(second["reason"]
        .as_str()
        .unwrap()
        .contains("Retry of a failed delegation"));
    let row = stored(&state, second["request_id"].as_str().unwrap()).await;
    assert_eq!(row.attempt, 2);
    assert_eq!(row.escalated_from.as_deref(), first["request_id"].as_str());
    assert_eq!(row.exclude, vec!["fast"]);
    assert_eq!(row.min_tier.as_deref(), Some("balanced"));
    assert_eq!(row.candidates.as_array().unwrap().len(), 2);

    let mut nothing = request("x");
    nothing["exclude"] = json!(["deep"]);
    nothing["min_tier"] = json!("deep");
    let (status, value) = call(&state, "POST", "/autoroute/v1/route", &[], &nothing).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{value}");
}

#[tokio::test]
async fn the_heuristic_classifier_makes_no_model_call_and_is_named_on_the_record() {
    let classifier = spawn_classifier(EASY).await;
    let mut config = config();
    config.openrouter_decisions_url = format!("http://{}/v1/decisions", classifier.addr);
    config.autoroute_delegation.classifier = "heuristic".into();
    let state = boot_with(config, &temp_db("heuristic"), true).await;
    let (status, value) = call(
        &state,
        "POST",
        "/autoroute/v1/route",
        &[AUTH],
        &request("Rename foo to bar."),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{value}");
    assert_eq!(*classifier.hits.lock().unwrap(), 0);
    assert_eq!(value["classifier"], "heuristic");
    assert!(value["reason"]
        .as_str()
        .unwrap()
        .contains("(heuristic classifier)"));
    let row = stored(&state, value["request_id"].as_str().unwrap()).await;
    assert_eq!(row.classifier_requested, "heuristic");
    assert_eq!(row.classifier_status, "used");
    assert_eq!(row.fallback_reason, None);
}

#[tokio::test]
async fn the_jev_classifier_still_decides_by_default() {
    let classifier = spawn_classifier(EASY).await;
    let mut config = config();
    config.openrouter_decisions_url = format!("http://{}/v1/decisions", classifier.addr);
    let state = boot_with(config, &temp_db("jev"), true).await;
    let (_, value) = call(
        &state,
        "POST",
        "/autoroute/v1/route",
        &[AUTH],
        &request("Rename foo to bar."),
    )
    .await;
    assert_eq!(*classifier.hits.lock().unwrap(), 1);
    assert_eq!(value["classifier"], "jev");
    let row = stored(&state, value["request_id"].as_str().unwrap()).await;
    assert_eq!(row.classifier, "jev");
    assert_eq!(row.classifier_version, "jev-v1");
    assert_eq!(row.classifier_status, "used");
}

#[tokio::test]
async fn the_learned_classifier_falls_back_to_the_heuristic_and_records_why() {
    let classifier = spawn_classifier(EASY).await;
    for (path, why) in [
        ("", "no autoroute.delegation.model_path configured"),
        ("/nonexistent/model.onnx", "model file not found"),
        ("Cargo.toml", "this build has no model runtime"),
    ] {
        let mut config = config();
        config.openrouter_decisions_url = format!("http://{}/v1/decisions", classifier.addr);
        config.autoroute_delegation.classifier = "learned".into();
        config.autoroute_delegation.model_path = path.into();
        let state = boot_with(config, &temp_db("learned"), true).await;
        let (_, value) = call(
            &state,
            "POST",
            "/autoroute/v1/route",
            &[AUTH],
            &request("Rename foo to bar."),
        )
        .await;
        assert_eq!(value["classifier"], "heuristic");
        assert!(value["reason"].as_str().unwrap().contains(why), "{value}");
        let row = stored(&state, value["request_id"].as_str().unwrap()).await;
        assert_eq!(row.classifier_requested, "learned");
        assert_eq!(row.classifier, "heuristic");
        assert!(row.fallback_reason.unwrap().contains(why));
    }
    assert_eq!(*classifier.hits.lock().unwrap(), 0);
}

#[test]
fn the_classifier_setting_is_validated_at_load() {
    assert_eq!(
        DelegationClassifier::parse("Heuristic", ""),
        Some(DelegationClassifier::Heuristic)
    );
    assert_eq!(DelegationClassifier::parse("onnx", ""), None);
    let shipped =
        octo::config::Config::load_from_directory(std::path::Path::new("config")).unwrap();
    assert_eq!(
        shipped.autoroute_delegation,
        octo::auto::DelegationSettings::default()
    );
    let dir = std::env::temp_dir().join(format!("octo-delegation-cfg-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    for entry in std::fs::read_dir("config").unwrap() {
        let path = entry.unwrap().path();
        if path.extension().is_some_and(|ext| ext == "toml") {
            std::fs::copy(&path, dir.join(path.file_name().unwrap())).unwrap();
        }
    }
    std::fs::write(
        dir.join("autoroute.toml"),
        "[autoroute.delegation]\nclassifier = \"onnx\"\n",
    )
    .unwrap();
    let err = octo::config::Config::load_from_directory(&dir).unwrap_err();
    std::fs::remove_dir_all(&dir).ok();
    assert!(
        err.to_string().contains("autoroute.delegation.classifier"),
        "{err}"
    );
}

#[test]
fn the_heuristic_rule_reads_keywords_tools_and_depth() {
    use octo::auto::{delegation_heuristic, inspect, Band, HeuristicInput};
    let band = |text: &str, tools: &[&str], depth: u32| {
        let facts = inspect(&json!({"messages": []}), text);
        let tools: Vec<String> = tools.iter().map(|t| t.to_string()).collect();
        delegation_heuristic(&HeuristicInput {
            facts: &facts,
            text,
            tools: &tools,
            depth,
            candidates: &[],
        })
    };
    assert_eq!(band("Rename it", &["edit_file"], 1), Band::Easy);
    assert_eq!(
        band(
            "Fix the race condition in src/a.rs and src/b.rs",
            &["edit_file"],
            1
        ),
        Band::Hard,
        "keyword plus several files"
    );
    assert_eq!(
        band(
            "Fix the race condition in src/a.rs and src/b.rs",
            &["read_file"],
            1
        ),
        Band::Medium,
        "read-only tools cap at medium"
    );
    assert_eq!(
        band(
            "Fix the race condition in src/a.rs and src/b.rs",
            &["edit_file"],
            2
        ),
        Band::Medium,
        "nested delegations cap at medium"
    );
    assert_eq!(
        band("Traceback (most recent call last): boom", &["read_file"], 3),
        Band::Hard,
        "a stack trace is always hard"
    );
}

fn report(event: OutcomeEvent) -> OutcomeReport {
    OutcomeReport {
        report_id: "r".into(),
        event,
        status: None,
        agent_signal: None,
        error_kind: None,
        session_id: None,
        usage: None,
        duration_ms: None,
        tests: None,
        by: None,
        after_failure: None,
        reason: None,
        at: None,
    }
}

fn done(status: FinishStatus, signal: AgentSignal) -> OutcomeReport {
    OutcomeReport {
        status: Some(status),
        agent_signal: Some(signal),
        ..report(OutcomeEvent::Finished)
    }
}

#[test]
fn the_solved_label_follows_its_written_rule_in_order() {
    let session = |status: &str| SessionOutcome {
        last_test_tool: "cargo".into(),
        tests_passed: 1,
        tests_failed: 0,
        tests_errors: 0,
        last_status: status.into(),
    };
    let case = |reports: Vec<OutcomeReport>, tests: Option<SessionOutcome>| {
        let label = derive_label(&reports, tests.as_ref());
        (label.solved, label.rule)
    };
    use AgentSignal::{CouldNot, Done};
    use FinishStatus::*;
    assert_eq!(case(vec![], None), (Solved::Unknown, "no_outcome"));
    assert_eq!(
        case(vec![report(OutcomeEvent::Rewound)], None),
        (Solved::Unknown, "no_outcome")
    );
    assert_eq!(
        case(vec![done(Stopped, AgentSignal::None)], None),
        (Solved::Unknown, "stopped")
    );
    for status in [Failed, TimedOut, AgentError] {
        assert_eq!(
            case(vec![done(status, AgentSignal::None)], None),
            (Solved::No, "did_not_finish")
        );
    }
    assert_eq!(
        case(vec![done(Completed, CouldNot)], None),
        (Solved::No, "could_not")
    );
    assert_eq!(
        case(
            vec![done(Completed, Done), report(OutcomeEvent::Escalated)],
            None
        ),
        (Solved::No, "escalated")
    );
    let redo = OutcomeReport {
        after_failure: Some(false),
        ..report(OutcomeEvent::Redelegated)
    };
    let label = derive_label(&[done(Completed, Done), redo], None);
    assert_eq!(
        (label.solved, label.rule, label.confidence),
        (Solved::No, "redelegated", "low")
    );
    assert_eq!(
        case(
            vec![done(Completed, Done), report(OutcomeEvent::Rewound)],
            Some(session("pass"))
        ),
        (Solved::No, "undone")
    );
    assert_eq!(
        case(vec![done(Completed, Done)], Some(session("fail"))),
        (Solved::No, "tests_failed")
    );
    let harness_tests = OutcomeReport {
        tests: Some(TestsReport {
            passed: Some(4),
            failed: Some(0),
            status: "pass".into(),
        }),
        ..done(Completed, Done)
    };
    assert_eq!(
        case(vec![harness_tests], Some(session("fail"))),
        (Solved::Yes, "tests_passed"),
        "the harness's own test report wins over the router's parse"
    );
    assert_eq!(
        case(vec![done(Completed, AgentSignal::None)], None),
        (Solved::Unknown, "empty_report")
    );
    assert_eq!(
        case(vec![done(Completed, Done)], Some(session("pass"))),
        (Solved::Yes, "tests_passed")
    );
    assert_eq!(
        case(vec![done(Completed, Done)], Some(session("unknown"))),
        (Solved::Yes, "completed")
    );
    assert_eq!(
        case(vec![done(Failed, Done), done(Completed, Done)], None),
        (Solved::Yes, "completed"),
        "the latest finished report counts"
    );
}

#[tokio::test]
async fn the_export_writes_one_line_per_delegation_with_features_choice_cost_and_label() {
    let (state, db) = boot("export", true).await;
    let first = route(&state, &request("Rename foo to bar.")).await;
    let id = first["request_id"].as_str().unwrap().to_string();
    route(&state, &request("Another task")).await;
    state.history.drain().await;
    outcome(&state, &id, finished("r-1", "completed")).await;

    let pool = octo::export::open_read_only(&db).await.unwrap();
    let mut out = Vec::new();
    let count = octo::export::export(&pool, &mut out, false).await.unwrap();
    assert_eq!(count, 2);
    let lines: Vec<Value> = String::from_utf8(out)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    let line = lines.iter().find(|l| l["request_id"] == id).unwrap();
    assert_eq!(line["schema"], "octo.delegation.v1");
    assert_eq!(line["task"]["brief"], "Rename foo to bar.");
    assert_eq!(line["task"]["tools"], json!(["read_file", "edit_file"]));
    assert_eq!(line["decision"]["choice"], first["choice"]);
    assert_eq!(line["decision"]["classifier"], "heuristic");
    assert_eq!(line["cost"]["measured_usd"], 0.0042);
    assert_eq!(line["outcome"]["status"], "completed");
    assert_eq!(line["outcome"]["usage"]["turns"], 3);
    assert_eq!(line["label"]["solved"], "yes");
    assert_eq!(line["label"]["rule"], "completed");
    let other = lines.iter().find(|l| l["request_id"] != id).unwrap();
    assert_eq!(other["label"]["solved"], "unknown");
    assert_eq!(other["outcome"], Value::Null);

    let mut redacted = Vec::new();
    octo::export::export(&pool, &mut redacted, true)
        .await
        .unwrap();
    let text = String::from_utf8(redacted).unwrap();
    assert!(!text.contains("Rename foo to bar."));
    assert!(!text.contains("Fix the parser"));
    let line: Value = serde_json::from_str(text.lines().next().unwrap()).unwrap();
    assert_eq!(line["task"]["brief"], Value::Null);
    assert_eq!(line["task"]["text_stored"], false);
    assert!(line["task"]["brief_chars"].as_u64().unwrap() > 0);
    assert_eq!(line["task"]["brief_hash"].as_str().unwrap().len(), 64);
}

#[test]
fn the_export_arguments_need_an_output_file() {
    let parse = |args: &[&str]| octo::export::parse_args(args.iter().map(|s| s.to_string()));
    let ok = parse(&["--out", "x.jsonl", "--redact", "--db", "h.sqlite"]).unwrap();
    assert!(ok.redact);
    assert_eq!(ok.db.unwrap().to_str(), Some("h.sqlite"));
    assert!(parse(&["--redact"]).is_err());
    assert!(parse(&["--bogus"]).is_err());
}
