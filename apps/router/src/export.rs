//! `octo export-delegations`: one JSON line per delegation record, for the ML pipeline (schema in
//! docs/history.md, "Delegation export").

use std::io::Write;
use std::path::{Path, PathBuf};
use std::str::FromStr;

use serde_json::{json, Value};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::SqlitePool;

use crate::auto::{derive_label, finished_session, parse_reports, OutcomeEvent, OutcomeReport};
use crate::history::{
    all_delegations, session_calls_cost, session_outcome, SessionOutcome, StoredDelegation,
    StoredOutcome,
};

/// Version of the line format; bump it when a field changes meaning or goes away.
pub const SCHEMA: &str = "octo.delegation.v1";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExportArgs {
    pub out: PathBuf,
    pub db: Option<PathBuf>,
    pub redact: bool,
}

pub fn usage() -> &'static str {
    "usage: octo export-delegations --out FILE.jsonl [--db PATH] [--redact]\n\n\
     Writes one JSON line per delegation record of the router's history database (default: history.database_path\n\
     of the configuration in $OCTO_CONFIG or ./config). --redact leaves out the task title and brief text and keeps\n\
     the derived features. The database is opened read-only. Schema: apps/router/docs/history.md.\n"
}

pub fn parse_args<I: IntoIterator<Item = String>>(args: I) -> Result<ExportArgs, String> {
    let mut out = None;
    let mut db = None;
    let mut redact = false;
    let mut args = args.into_iter();
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--out" | "-o" => out = args.next().map(PathBuf::from),
            "--db" => db = args.next().map(PathBuf::from),
            "--redact" => redact = true,
            "--help" | "-h" => return Err(usage().to_string()),
            other => return Err(format!("unknown argument {other:?}\n\n{}", usage())),
        }
    }
    let out = out.ok_or_else(|| format!("--out is required\n\n{}", usage()))?;
    Ok(ExportArgs { out, db, redact })
}

#[derive(Debug, thiserror::Error)]
pub enum ExportError {
    #[error("cannot open {path}: {source}")]
    Open {
        path: String,
        #[source]
        source: sqlx::Error,
    },
    #[error(
        "the database has no delegation records table (start this router version on it once): {0}"
    )]
    Read(#[source] crate::history::HistoryError),
    #[error("cannot write {path}: {source}")]
    Write {
        path: String,
        #[source]
        source: std::io::Error,
    },
    #[error(transparent)]
    Config(#[from] crate::config::ConfigError),
}

pub async fn open_read_only(path: &Path) -> Result<SqlitePool, ExportError> {
    let shown = path.display().to_string();
    let options = SqliteConnectOptions::from_str("sqlite://")
        .map_err(|source| ExportError::Open {
            path: shown.clone(),
            source,
        })?
        .filename(path)
        .read_only(true);
    SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .map_err(|source| ExportError::Open {
            path: shown,
            source,
        })
}

/// Writes every delegation of `pool` to `out` as JSON lines; returns how many.
pub async fn export(
    pool: &SqlitePool,
    out: &mut impl Write,
    redact: bool,
) -> Result<usize, ExportError> {
    let rows = all_delegations(pool).await.map_err(ExportError::Read)?;
    let mut written = 0;
    for (delegation, outcomes) in &rows {
        let bodies: Vec<Value> = outcomes.iter().map(|o| o.body.clone()).collect();
        let reports = parse_reports(&bodies);
        let session = match finished_session(&reports) {
            Some(id) => session_outcome(pool, id).await,
            None => None,
        };
        let router_cost = match finished_session(&reports) {
            Some(id) => session_calls_cost(pool, id).await,
            None => None,
        };
        let line = line(&LineInput {
            delegation,
            outcomes,
            reports: &reports,
            session: session.as_ref(),
            router_cost_micros: router_cost,
            redact,
        });
        let write = |out: &mut dyn Write| -> std::io::Result<()> {
            serde_json::to_writer(&mut *out, &line)?;
            out.write_all(b"\n")
        };
        write(out).map_err(|source| ExportError::Write {
            path: "output".into(),
            source,
        })?;
        written += 1;
    }
    Ok(written)
}

pub struct LineInput<'a> {
    pub delegation: &'a StoredDelegation,
    pub outcomes: &'a [StoredOutcome],
    pub reports: &'a [OutcomeReport],
    pub session: Option<&'a SessionOutcome>,
    pub router_cost_micros: Option<u64>,
    pub redact: bool,
}

fn usd(micros: u64) -> f64 {
    micros as f64 / 1_000_000.0
}

/// One export line (schema [`SCHEMA`]).
pub fn line(input: &LineInput<'_>) -> Value {
    let d = input.delegation;
    let label = derive_label(input.reports, input.session);
    let finished = input
        .reports
        .iter()
        .rev()
        .find(|report| report.event == OutcomeEvent::Finished);
    let tests = finished
        .and_then(|report| report.tests.as_ref())
        .filter(|tests| tests.status != "unknown")
        .map(|tests| {
            json!({"source": "harness", "status": tests.status, "passed": tests.passed, "failed": tests.failed})
        })
        .or_else(|| {
            input.session.map(|s| {
                json!({"source": "router", "status": s.last_status, "tool": s.last_test_tool,
                       "passed": s.tests_passed, "failed": s.tests_failed, "errors": s.tests_errors})
            })
        });
    let usage = finished.and_then(|report| report.usage.as_ref());
    let outcome = finished.map(|report| {
        json!({
            "status": report.status,
            "agent_signal": report.agent_signal,
            "error_kind": report.error_kind,
            "duration_ms": report.duration_ms,
            "session_id": report.session_id,
            "usage": report.usage,
            "tests": tests,
        })
    });
    let events: Vec<Value> = input
        .outcomes
        .iter()
        .map(|stored| {
            json!({
                "event": stored.event,
                "received_at": stored.received_at,
                "by": stored.body.get("by"),
                "after_failure": stored.body.get("after_failure"),
                "reason": stored.body.get("reason"),
            })
        })
        .collect();
    let probabilities = d
        .probabilities
        .map(|[low, mid, high]| json!({"low": low, "mid": mid, "high": high}));
    let text = |value: &Option<String>| {
        if input.redact {
            Value::Null
        } else {
            json!(value)
        }
    };
    json!({
        "schema": SCHEMA,
        "request_id": d.request_id,
        "created_at_ms": d.created_at,
        "budget_key": d.budget_key,
        "session_id": d.session_id,
        "attempt": d.attempt,
        "escalated_from": d.escalated_from,
        "task": {
            "title": text(&d.title),
            "brief": text(&d.brief),
            "text_stored": d.brief.is_some() && !input.redact,
            "title_chars": d.title_chars,
            "brief_chars": d.brief_chars,
            "brief_tokens_est": d.brief_tokens,
            "brief_hash": d.brief_hash,
            "text_features": d.text_features,
            "tools": d.tools,
            "tool_count": d.tools.len(),
            "depth": d.depth,
            "parent_tier": d.parent_tier,
        },
        "candidates": d.candidates,
        "exclude": d.exclude,
        "min_tier": d.min_tier,
        "decision": {
            "choice": d.choice,
            "choice_kind": d.choice_kind,
            "choice_tier": d.choice_tier,
            "model": d.model,
            "served_tier": d.served_tier,
            "band": d.band,
            "reason": d.reason,
            "classifier": d.classifier,
            "classifier_requested": d.classifier_requested,
            "classifier_version": d.classifier_version,
            "classifier_status": d.classifier_status,
            "fallback_reason": d.fallback_reason,
            "probabilities": probabilities,
        },
        "cost": {
            "estimated_usd": d.estimated_cost_micros.map(usd),
            "classifier_usd": usd(d.classifier_cost_micros),
            "measured_usd": usage.and_then(|u| u.cost_usd),
            "measured_is_estimate": usage.and_then(|u| u.cost_estimated),
            "measured_flat_rate": usage.and_then(|u| u.flat_rate),
            "router_calls_usd": input.router_cost_micros.map(usd),
        },
        "outcome": outcome,
        "events": events,
        "label": label,
    })
}

/// Runs the subcommand; returns the process exit code.
pub async fn run<I: IntoIterator<Item = String>>(args: I) -> i32 {
    let args = match parse_args(args) {
        Ok(args) => args,
        Err(text) => {
            eprint!("octo export-delegations: {text}");
            return 2;
        }
    };
    match run_with(&args).await {
        Ok(count) => {
            eprintln!(
                "octo export-delegations: wrote {count} delegation records to {}",
                args.out.display()
            );
            0
        }
        Err(err) => {
            eprintln!("octo export-delegations: {err}");
            1
        }
    }
}

async fn run_with(args: &ExportArgs) -> Result<usize, ExportError> {
    let db = match &args.db {
        Some(path) => path.clone(),
        None => PathBuf::from(crate::config::Config::load()?.history_database_path),
    };
    let pool = open_read_only(&db).await?;
    let file = std::fs::File::create(&args.out).map_err(|source| ExportError::Write {
        path: args.out.display().to_string(),
        source,
    })?;
    let mut out = std::io::BufWriter::new(file);
    let count = export(&pool, &mut out, args.redact).await?;
    out.flush().map_err(|source| ExportError::Write {
        path: args.out.display().to_string(),
        source,
    })?;
    pool.close().await;
    Ok(count)
}
