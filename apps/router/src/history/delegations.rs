use serde_json::Value;
use sqlx::sqlite::SqliteRow;
use sqlx::{Row, SqlitePool};

use super::error::HistoryError;
use super::records::now_millis;
use super::{History, SessionOutcome};

/// What the route endpoint knew when it decided: one row of `delegations`. Text fields are full here; whether the
/// title and brief text reach the database is decided by `store_payloads` when the row is written.
#[derive(Debug, Clone, PartialEq)]
pub struct DelegationInsert {
    pub request_id: String,
    pub budget_key: String,
    pub session_id: Option<String>,
    pub attempt: u32,
    pub escalated_from: Option<String>,
    pub title: String,
    pub brief: String,
    /// Facts derived from the text at decision time (kept when the text is not).
    pub text_features: Value,
    pub tools: Vec<String>,
    pub depth: u32,
    pub parent_tier: Option<String>,
    pub candidates: Value,
    pub exclude: Vec<String>,
    pub min_tier: Option<String>,
    pub choice: String,
    pub choice_kind: &'static str,
    pub choice_tier: Option<String>,
    pub model: Option<String>,
    pub served_tier: String,
    pub band: String,
    pub reason: String,
    pub classifier: String,
    pub classifier_requested: String,
    pub classifier_version: String,
    pub classifier_status: String,
    pub fallback_reason: Option<String>,
    pub probabilities: Option<[f64; 3]>,
    pub estimated_cost_micros: Option<u64>,
    pub classifier_cost_micros: u64,
}

/// A stored delegation row, as read back for a label or the export.
#[derive(Debug, Clone, PartialEq)]
pub struct StoredDelegation {
    pub request_id: String,
    pub created_at: i64,
    pub budget_key: String,
    pub session_id: Option<String>,
    pub attempt: u32,
    pub escalated_from: Option<String>,
    pub title: Option<String>,
    pub brief: Option<String>,
    pub title_chars: u64,
    pub brief_chars: u64,
    pub brief_tokens: u64,
    pub brief_hash: String,
    pub text_features: Value,
    pub tools: Vec<String>,
    pub depth: u32,
    pub parent_tier: Option<String>,
    pub candidates: Value,
    pub exclude: Vec<String>,
    pub min_tier: Option<String>,
    pub choice: String,
    pub choice_kind: String,
    pub choice_tier: Option<String>,
    pub model: Option<String>,
    pub served_tier: String,
    pub band: String,
    pub reason: String,
    pub classifier: String,
    pub classifier_requested: String,
    pub classifier_version: String,
    pub classifier_status: String,
    pub fallback_reason: Option<String>,
    pub probabilities: Option<[f64; 3]>,
    pub estimated_cost_micros: Option<u64>,
    pub classifier_cost_micros: u64,
    pub solved: String,
    pub solved_rule: String,
    pub solved_confidence: String,
    pub outcome_at: Option<i64>,
}

/// One outcome report as stored: the event name, when it arrived, and the report body as sent.
#[derive(Debug, Clone, PartialEq)]
pub struct StoredOutcome {
    pub event: String,
    pub received_at: i64,
    pub body: Value,
}

/// The label columns of a delegation, written after every outcome report.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LabelColumns {
    pub solved: &'static str,
    pub rule: &'static str,
    pub confidence: &'static str,
}

/// Rough token count of a text: one token per four characters, rounded up.
pub fn estimate_tokens(chars: u64) -> u64 {
    chars.div_ceil(4)
}

fn to_sql(value: u64) -> i64 {
    i64::try_from(value).unwrap_or(i64::MAX)
}

fn from_sql(value: i64) -> u64 {
    u64::try_from(value).unwrap_or(0)
}

impl History {
    pub fn store_payloads(&self) -> bool {
        self.store_payloads
    }

    /// The salted hash of a delegation's text: HMAC-SHA256 with this installation's history token key, so equal
    /// briefs can be counted and matched without keeping the text.
    pub fn text_hash(&self, text: &str) -> String {
        self.token_hash(text).unwrap_or_default()
    }

    /// Writes a delegation row off the request path (same bounded queue as the call records).
    pub fn record_delegation(&self, row: DelegationInsert) {
        let store_text = self.store_payloads;
        let brief_hash = self.text_hash(&row.brief);
        self.spawn_write("delegation record", move |pool| {
            Box::pin(async move {
                if let Err(err) = insert_delegation(&pool, &row, store_text, &brief_hash).await {
                    tracing::warn!(%err, request_id = row.request_id, "delegation insert failed");
                }
            })
        });
    }

    pub async fn delegation(
        &self,
        request_id: &str,
    ) -> Result<Option<StoredDelegation>, HistoryError> {
        let Some(pool) = self.pool.as_ref() else {
            return Ok(None);
        };
        let row = sqlx::query("SELECT * FROM delegations WHERE request_id = ?")
            .bind(request_id)
            .fetch_optional(pool)
            .await?;
        Ok(row.as_ref().map(delegation_from_row))
    }

    /// Stores one outcome report. `Ok(false)` means the same `report_id` was already stored for this delegation (the
    /// report is not stored twice).
    pub async fn insert_outcome(
        &self,
        request_id: &str,
        report_id: &str,
        event: &str,
        body: &Value,
    ) -> Result<bool, HistoryError> {
        let Some(pool) = self.pool.as_ref() else {
            return Ok(false);
        };
        let done = sqlx::query(
            r#"
            INSERT INTO delegation_outcomes (request_id, report_id, received_at, event, body)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(request_id, report_id) DO NOTHING
            "#,
        )
        .bind(request_id)
        .bind(report_id)
        .bind(now_millis())
        .bind(event)
        .bind(body.to_string())
        .execute(pool)
        .await?;
        Ok(done.rows_affected() == 1)
    }

    pub async fn outcomes(&self, request_id: &str) -> Result<Vec<StoredOutcome>, HistoryError> {
        let Some(pool) = self.pool.as_ref() else {
            return Ok(Vec::new());
        };
        let rows = sqlx::query(
            "SELECT event, received_at, body FROM delegation_outcomes WHERE request_id = ? ORDER BY seq",
        )
        .bind(request_id)
        .fetch_all(pool)
        .await?;
        Ok(rows
            .iter()
            .map(|row| StoredOutcome {
                event: row.get("event"),
                received_at: row.get("received_at"),
                body: serde_json::from_str(&row.get::<String, _>("body")).unwrap_or(Value::Null),
            })
            .collect())
    }

    pub async fn set_delegation_label(
        &self,
        request_id: &str,
        label: &LabelColumns,
    ) -> Result<(), HistoryError> {
        let Some(pool) = self.pool.as_ref() else {
            return Ok(());
        };
        sqlx::query(
            "UPDATE delegations SET solved = ?, solved_rule = ?, solved_confidence = ?, outcome_at = ? WHERE request_id = ?",
        )
        .bind(label.solved)
        .bind(label.rule)
        .bind(label.confidence)
        .bind(now_millis())
        .bind(request_id)
        .execute(pool)
        .await?;
        Ok(())
    }

    /// The last test summary the router parsed for a session (`session_outcomes`), if any.
    pub async fn session_outcome(&self, session_id: &str) -> Option<SessionOutcome> {
        let pool = self.pool.as_ref()?;
        session_outcome(pool, session_id).await
    }

    /// Sum of the reported or estimated cost of the proxied calls of a session (`calls`), in micro-USD.
    pub async fn session_calls_cost_micros(&self, session_id: &str) -> Option<u64> {
        let pool = self.pool.as_ref()?;
        session_calls_cost(pool, session_id).await
    }
}

pub async fn session_outcome(pool: &SqlitePool, session_id: &str) -> Option<SessionOutcome> {
    let row = sqlx::query(
        "SELECT last_test_tool, tests_passed, tests_failed, tests_errors, last_status FROM session_outcomes WHERE session_id = ?",
    )
    .bind(session_id)
    .fetch_optional(pool)
    .await
    .ok()??;
    Some(SessionOutcome {
        last_test_tool: row
            .get::<Option<String>, _>("last_test_tool")
            .unwrap_or_default(),
        tests_passed: row.get("tests_passed"),
        tests_failed: row.get("tests_failed"),
        tests_errors: row.get("tests_errors"),
        last_status: row.get("last_status"),
    })
}

pub async fn session_calls_cost(pool: &SqlitePool, session_id: &str) -> Option<u64> {
    let row = sqlx::query(
        "SELECT COUNT(*) AS n, COALESCE(SUM(cost_micros), 0) AS micros FROM calls WHERE session_id = ?",
    )
    .bind(session_id)
    .fetch_one(pool)
    .await
    .ok()?;
    if row.get::<i64, _>("n") == 0 {
        return None;
    }
    Some(from_sql(row.get("micros")))
}

/// Every delegation row, oldest first, with its outcome reports (for the export).
pub async fn all_delegations(
    pool: &SqlitePool,
) -> Result<Vec<(StoredDelegation, Vec<StoredOutcome>)>, HistoryError> {
    let rows = sqlx::query("SELECT * FROM delegations ORDER BY seq")
        .fetch_all(pool)
        .await?;
    let mut out = Vec::with_capacity(rows.len());
    for row in &rows {
        let delegation = delegation_from_row(row);
        let outcomes = sqlx::query(
            "SELECT event, received_at, body FROM delegation_outcomes WHERE request_id = ? ORDER BY seq",
        )
        .bind(&delegation.request_id)
        .fetch_all(pool)
        .await?
        .iter()
        .map(|row| StoredOutcome {
            event: row.get("event"),
            received_at: row.get("received_at"),
            body: serde_json::from_str(&row.get::<String, _>("body")).unwrap_or(Value::Null),
        })
        .collect();
        out.push((delegation, outcomes));
    }
    Ok(out)
}

async fn insert_delegation(
    pool: &SqlitePool,
    row: &DelegationInsert,
    store_text: bool,
    brief_hash: &str,
) -> Result<(), HistoryError> {
    let title_chars = row.title.chars().count() as u64;
    let brief_chars = row.brief.chars().count() as u64;
    let tools = serde_json::to_string(&row.tools).unwrap_or_else(|_| "[]".into());
    let exclude = serde_json::to_string(&row.exclude).unwrap_or_else(|_| "[]".into());
    let [p_low, p_mid, p_high] = match row.probabilities {
        Some([low, mid, high]) => [Some(low), Some(mid), Some(high)],
        None => [None, None, None],
    };
    sqlx::query(
        r#"
        INSERT INTO delegations (
            request_id, created_at, budget_key, session_id, attempt, escalated_from,
            title, brief, title_chars, brief_chars, brief_tokens, brief_hash, text_features,
            tools, tool_count, depth, parent_tier, candidates, exclude, min_tier,
            choice, choice_kind, choice_tier, model, served_tier, band, reason,
            classifier, classifier_requested, classifier_version, classifier_status, fallback_reason,
            p_low, p_mid, p_high, estimated_cost_micros, classifier_cost_micros
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(request_id) DO NOTHING
        "#,
    )
    .bind(&row.request_id)
    .bind(now_millis())
    .bind(&row.budget_key)
    .bind(&row.session_id)
    .bind(i64::from(row.attempt))
    .bind(&row.escalated_from)
    .bind(store_text.then_some(&row.title))
    .bind(store_text.then_some(&row.brief))
    .bind(to_sql(title_chars))
    .bind(to_sql(brief_chars))
    .bind(to_sql(estimate_tokens(brief_chars)))
    .bind(brief_hash)
    .bind(row.text_features.to_string())
    .bind(tools)
    .bind(row.tools.len() as i64)
    .bind(i64::from(row.depth))
    .bind(&row.parent_tier)
    .bind(row.candidates.to_string())
    .bind(exclude)
    .bind(&row.min_tier)
    .bind(&row.choice)
    .bind(row.choice_kind)
    .bind(&row.choice_tier)
    .bind(&row.model)
    .bind(&row.served_tier)
    .bind(&row.band)
    .bind(&row.reason)
    .bind(&row.classifier)
    .bind(&row.classifier_requested)
    .bind(&row.classifier_version)
    .bind(&row.classifier_status)
    .bind(&row.fallback_reason)
    .bind(p_low)
    .bind(p_mid)
    .bind(p_high)
    .bind(row.estimated_cost_micros.map(to_sql))
    .bind(to_sql(row.classifier_cost_micros))
    .execute(pool)
    .await?;
    Ok(())
}

fn json_list(raw: &str) -> Vec<String> {
    serde_json::from_str(raw).unwrap_or_default()
}

fn delegation_from_row(row: &SqliteRow) -> StoredDelegation {
    let probabilities = match (
        row.get::<Option<f64>, _>("p_low"),
        row.get::<Option<f64>, _>("p_mid"),
        row.get::<Option<f64>, _>("p_high"),
    ) {
        (Some(low), Some(mid), Some(high)) => Some([low, mid, high]),
        _ => None,
    };
    StoredDelegation {
        request_id: row.get("request_id"),
        created_at: row.get("created_at"),
        budget_key: row.get("budget_key"),
        session_id: row.get("session_id"),
        attempt: u32::try_from(row.get::<i64, _>("attempt")).unwrap_or(1),
        escalated_from: row.get("escalated_from"),
        title: row.get("title"),
        brief: row.get("brief"),
        title_chars: from_sql(row.get("title_chars")),
        brief_chars: from_sql(row.get("brief_chars")),
        brief_tokens: from_sql(row.get("brief_tokens")),
        brief_hash: row.get("brief_hash"),
        text_features: serde_json::from_str(&row.get::<String, _>("text_features"))
            .unwrap_or(Value::Null),
        tools: json_list(&row.get::<String, _>("tools")),
        depth: u32::try_from(row.get::<i64, _>("depth")).unwrap_or(0),
        parent_tier: row.get("parent_tier"),
        candidates: serde_json::from_str(&row.get::<String, _>("candidates"))
            .unwrap_or(Value::Null),
        exclude: json_list(&row.get::<String, _>("exclude")),
        min_tier: row.get("min_tier"),
        choice: row.get("choice"),
        choice_kind: row.get("choice_kind"),
        choice_tier: row.get("choice_tier"),
        model: row.get("model"),
        served_tier: row.get("served_tier"),
        band: row.get("band"),
        reason: row.get("reason"),
        classifier: row.get("classifier"),
        classifier_requested: row.get("classifier_requested"),
        classifier_version: row.get("classifier_version"),
        classifier_status: row.get("classifier_status"),
        fallback_reason: row.get("fallback_reason"),
        probabilities,
        estimated_cost_micros: row
            .get::<Option<i64>, _>("estimated_cost_micros")
            .map(from_sql),
        classifier_cost_micros: from_sql(row.get("classifier_cost_micros")),
        solved: row.get("solved"),
        solved_rule: row.get("solved_rule"),
        solved_confidence: row.get("solved_confidence"),
        outcome_at: row.get("outcome_at"),
    }
}
