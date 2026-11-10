use std::path::Path;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use hmac::{Hmac, Mac};
use sha2::Sha256;
use sqlx::SqlitePool;
use tokio::sync::{Notify, Semaphore};

mod call;
mod call_kind;
mod call_provider;
mod connect;
mod cost;
mod error;
mod metrics;
mod outcomes;
mod payload;

pub use call::{CallObserve, DecisionRow, FinishedCall};
pub use call_kind::CallKind;
pub use call_provider::CallProvider;
pub use cost::{
    blended_cost_micros, resolve_cost, CostSource, ModelPrice, PriceTable, ResolvedCost,
};
pub use error::HistoryError;
pub use metrics::{CostMicros, Millis, TokenCount};
pub use outcomes::{parse_test_summary, parse_tool_results_outcome, SessionOutcome};
pub use payload::cost_micros_from_json;
pub use payload::{
    complete_dropped_usage, describe_input, is_subagent, request_payload, response_payload,
    token_from_headers, usage_from_output, usage_from_parts, DroppedStream, ParsedUsage,
};

type HmacSha256 = Hmac<Sha256>;

const INSERT_SLOTS: usize = 32;

#[derive(Debug, Clone)]
pub struct SessionCallStats {
    pub calls: i64,
    pub cost_micros: u64,
    pub updated_at: i64,
    pub last_trigger: Option<String>,
    pub last_model: Option<String>,
    pub cost_source_breakdown: serde_json::Value,
}

#[derive(Clone)]
pub struct History {
    pool: Option<SqlitePool>,
    token_key: Vec<u8>,
    capture_limit: usize,
    prices: Arc<PriceTable>,
    store_payloads: bool,
    inserts: Arc<Semaphore>,
    insert_acquire_timeout: Duration,
    inflight: Arc<AtomicUsize>,
    idle: Arc<Notify>,
    dropped_inserts: Arc<AtomicU64>,
}

impl History {
    pub fn disabled() -> Self {
        Self {
            pool: None,
            token_key: Vec::new(),
            capture_limit: 0,
            prices: Arc::new(PriceTable::default()),
            store_payloads: true,
            inserts: Arc::new(Semaphore::new(INSERT_SLOTS)),
            insert_acquire_timeout: Duration::from_secs(5),
            inflight: Arc::new(AtomicUsize::new(0)),
            idle: Arc::new(Notify::new()),
            dropped_inserts: Arc::new(AtomicU64::new(0)),
        }
    }

    pub fn dropped_inserts(&self) -> u64 {
        self.dropped_inserts.load(Ordering::Relaxed)
    }

    pub fn capture_limit(&self) -> usize {
        self.capture_limit
    }

    pub fn prices(&self) -> &PriceTable {
        &self.prices
    }

    pub fn with_prices(mut self, prices: PriceTable) -> Self {
        self.prices = Arc::new(prices);
        self
    }

    pub fn with_store_payloads(mut self, store_payloads: bool) -> Self {
        self.store_payloads = store_payloads;
        self
    }

    pub fn with_insert_slots(mut self, slots: usize) -> Self {
        self.inserts = Arc::new(Semaphore::new(slots));
        self
    }

    pub fn with_insert_acquire_timeout(mut self, timeout: Duration) -> Self {
        self.insert_acquire_timeout = timeout;
        self
    }

    pub async fn connect(
        database_path: &str,
        token_key: &str,
        capture_limit: usize,
    ) -> Result<Self, HistoryError> {
        let key = load_token_key(database_path, token_key)?;
        let pool = connect::open_pool(database_path).await?;
        if database_path != "sqlite::memory:" {
            restrict_file(Path::new(database_path))?;
        }
        Ok(Self {
            pool: Some(pool),
            token_key: key,
            capture_limit,
            prices: Arc::new(PriceTable::default()),
            store_payloads: true,
            inserts: Arc::new(Semaphore::new(INSERT_SLOTS)),
            insert_acquire_timeout: Duration::from_secs(5),
            inflight: Arc::new(AtomicUsize::new(0)),
            idle: Arc::new(Notify::new()),
            dropped_inserts: Arc::new(AtomicU64::new(0)),
        })
    }

    pub fn enabled(&self) -> bool {
        self.pool.is_some()
    }

    pub async fn drain(&self) {
        let timeout = Duration::from_secs(5);
        let started = tokio::time::Instant::now();
        loop {
            if self.inflight.load(Ordering::Acquire) == 0 {
                return;
            }
            let left = timeout.saturating_sub(started.elapsed());
            if left.is_zero() {
                tracing::warn!(
                    remaining = self.inflight.load(Ordering::Acquire),
                    "history drain timed out"
                );
                return;
            }
            tokio::select! {
                _ = self.idle.notified() => {}
                _ = tokio::time::sleep(left) => {}
            }
        }
    }

    pub fn pool(&self) -> Option<&SqlitePool> {
        self.pool.as_ref()
    }

    pub fn token_hash(&self, secret: &str) -> Result<String, HistoryError> {
        let mut mac =
            HmacSha256::new_from_slice(&self.token_key).map_err(|_| HistoryError::TokenKey)?;
        mac.update(secret.as_bytes());
        Ok(hex::encode(mac.finalize().into_bytes()))
    }

    pub fn record_decision(&self, row: DecisionRow) {
        let Some(pool) = self.pool.clone() else {
            return;
        };
        let limit = self.capture_limit;
        let inserts = self.inserts.clone();
        let inflight = self.inflight.clone();
        let idle = self.idle.clone();
        inflight.fetch_add(1, Ordering::AcqRel);
        tokio::spawn(async move {
            struct Done(Arc<AtomicUsize>, Arc<Notify>);
            impl Drop for Done {
                fn drop(&mut self) {
                    if self.0.fetch_sub(1, Ordering::AcqRel) == 1 {
                        self.1.notify_waiters();
                    }
                }
            }
            let _done = Done(inflight, idle);
            let Ok(Ok(permit)) =
                tokio::time::timeout(Duration::from_secs(5), inserts.acquire_owned()).await
            else {
                tracing::warn!(
                    choice_rule = %row.choice_rule,
                    session_id = row.session_id.as_deref().unwrap_or(""),
                    "decision insert skipped; queue wait timed out"
                );
                return;
            };
            let _permit = permit;
            if let Err(err) = insert_decision(&pool, &row, limit).await {
                tracing::warn!(%err, choice_rule = %row.choice_rule, "decision insert failed");
            }
        });
    }

    pub async fn session_cost_micros(&self, session_id: &str) -> Result<u64, HistoryError> {
        let Some(pool) = self.pool.as_ref() else {
            return Ok(0);
        };
        let row = sqlx::query!(
            r#"
            SELECT
              (SELECT COALESCE(SUM(cost_micros), 0) FROM calls WHERE session_id = ?1) +
              (SELECT COALESCE(SUM(cost_micros), 0) FROM decisions WHERE session_id = ?1)
            AS total
            "#,
            session_id
        )
        .fetch_one(pool)
        .await?;
        Ok(u64::try_from(row.total).unwrap_or(u64::MAX))
    }

    pub async fn session_call_stats(&self, session_id: &str) -> Option<SessionCallStats> {
        let pool = self.pool.as_ref()?;
        let summary = sqlx::query(
            r#"
            SELECT
              COUNT(*) AS calls,
              COALESCE(SUM(cost_micros), 0) AS cost_micros,
              COALESCE(MAX(created_at), 0) AS updated_at
            FROM calls
            WHERE session_id = ?
            "#,
        )
        .bind(session_id)
        .fetch_one(pool)
        .await
        .ok()?;
        use sqlx::Row;
        let calls = summary.get::<i64, _>("calls");
        let cost_micros = u64::try_from(summary.get::<i64, _>("cost_micros")).unwrap_or(0);
        let updated_at = summary.get::<i64, _>("updated_at");
        let last = sqlx::query(
            r#"
            SELECT trigger, model FROM calls
            WHERE session_id = ?
            ORDER BY id DESC
            LIMIT 1
            "#,
        )
        .bind(session_id)
        .fetch_optional(pool)
        .await
        .ok()
        .flatten();
        let (last_trigger, last_model) = match last {
            Some(row) => (
                row.get::<Option<String>, _>("trigger"),
                row.get::<Option<String>, _>("model"),
            ),
            None => (None, None),
        };
        let sources = sqlx::query(
            r#"
            SELECT COALESCE(cost_source, 'none') AS cost_source,
                   COALESCE(SUM(cost_micros), 0) AS micros
            FROM calls
            WHERE session_id = ?
            GROUP BY COALESCE(cost_source, 'none')
            "#,
        )
        .bind(session_id)
        .fetch_all(pool)
        .await
        .unwrap_or_default();
        let mut breakdown = serde_json::Map::new();
        for row in sources {
            let source: String = row.get("cost_source");
            let micros = row.get::<i64, _>("micros") as f64 / 1_000_000.0;
            breakdown.insert(source, serde_json::json!(micros));
        }
        Some(SessionCallStats {
            calls,
            cost_micros,
            updated_at,
            last_trigger,
            last_model,
            cost_source_breakdown: serde_json::Value::Object(breakdown),
        })
    }

    pub fn record(&self, call: FinishedCall) {
        let Some(pool) = self.pool.clone() else {
            return;
        };
        let inserts = self.inserts.clone();
        let inflight = self.inflight.clone();
        let idle = self.idle.clone();
        let dropped = self.dropped_inserts.clone();
        let store_payloads = self.store_payloads;
        let acquire_timeout = self.insert_acquire_timeout;
        inflight.fetch_add(1, Ordering::AcqRel);
        tokio::spawn(async move {
            struct Done(Arc<AtomicUsize>, Arc<Notify>);
            impl Drop for Done {
                fn drop(&mut self) {
                    if self.0.fetch_sub(1, Ordering::AcqRel) == 1 {
                        self.1.notify_waiters();
                    }
                }
            }
            let _done = Done(inflight, idle);
            let permit = match tokio::time::timeout(acquire_timeout, inserts.acquire_owned()).await
            {
                Ok(Ok(permit)) => permit,
                Ok(Err(_)) => {
                    dropped.fetch_add(1, Ordering::Relaxed);
                    tracing::warn!(
                        kind = %call.kind,
                        provider = %call.provider,
                        session_id = call.session_id.as_deref().unwrap_or(""),
                        "history insert skipped; insert pool closed"
                    );
                    return;
                }
                Err(_) => {
                    dropped.fetch_add(1, Ordering::Relaxed);
                    tracing::warn!(
                        kind = %call.kind,
                        provider = %call.provider,
                        session_id = call.session_id.as_deref().unwrap_or(""),
                        model = call.model.as_deref().unwrap_or(""),
                        trigger = %call.trigger,
                        "history insert skipped; queue wait timed out"
                    );
                    return;
                }
            };
            let _permit = permit;
            let captured_bytes = call.request_bytes.saturating_add(call.response_bytes);
            match insert_call(&pool, &call, store_payloads).await {
                Ok(()) => {
                    tracing::info!(
                        kind = %call.kind,
                        provider = %call.provider,
                        model = call.model.as_deref().unwrap_or(""),
                        status = call.status,
                        latency_ms = call.latency_ms.0,
                        request_bytes = call.request_bytes,
                        response_bytes = call.response_bytes,
                        captured_bytes,
                        input_tokens = ?call.input_tokens,
                        output_tokens = ?call.output_tokens,
                        cost_micros = ?call.cost.map(|c| c.0),
                        session_id = call.session_id.as_deref().unwrap_or(""),
                        "call stored"
                    );
                    if let Some(session_id) = call.session_id.as_deref() {
                        if let Some(outcome) = outcomes::parse_tool_results_outcome(&call.input) {
                            if let Err(err) =
                                outcomes::upsert_session_outcome(&pool, session_id, &outcome).await
                            {
                                tracing::warn!(%err, session_id, "session_outcomes upsert failed");
                            }
                        }
                    }
                }
                Err(err) => {
                    tracing::warn!(
                        %err,
                        kind = %call.kind,
                        provider = %call.provider,
                        status = call.status,
                        session_id = call.session_id.as_deref().unwrap_or(""),
                        "history insert failed"
                    );
                }
            }
        });
    }
}

fn load_token_key(database_path: &str, configured: &str) -> Result<Vec<u8>, HistoryError> {
    if let Ok(from_env) = std::env::var("OCTO_HISTORY_TOKEN_KEY") {
        if !from_env.is_empty() {
            return Ok(from_env.into_bytes());
        }
    }
    if !configured.is_empty() {
        return Ok(configured.as_bytes().to_vec());
    }
    if database_path == "sqlite::memory:" {
        return Ok(b"test-token-key".to_vec());
    }
    let key_path = Path::new(database_path).with_extension("key");
    if let Some(parent) = key_path.parent() {
        if !parent.as_os_str().is_empty() {
            secure_dir(parent)?;
        }
    }
    if key_path.is_file() {
        return std::fs::read(&key_path).map_err(|source| HistoryError::ReadKey {
            path: key_path.display().to_string(),
            source,
        });
    }
    let mut key = vec![0_u8; 32];
    let mut file = std::fs::File::open("/dev/urandom").map_err(|source| HistoryError::ReadKey {
        path: "/dev/urandom".to_string(),
        source,
    })?;
    use std::io::Read;
    file.read_exact(&mut key)
        .map_err(|source| HistoryError::ReadKey {
            path: "/dev/urandom".to_string(),
            source,
        })?;
    match write_private(&key_path, &key) {
        Ok(()) => Ok(key),
        Err(HistoryError::ReadKey { source, .. })
            if source.kind() == std::io::ErrorKind::AlreadyExists =>
        {
            std::fs::read(&key_path).map_err(|source| HistoryError::ReadKey {
                path: key_path.display().to_string(),
                source,
            })
        }
        Err(err) => Err(err),
    }
}

fn secure_dir(path: &Path) -> Result<(), HistoryError> {
    std::fs::create_dir_all(path).map_err(|source| HistoryError::CreateDir {
        path: path.display().to_string(),
        source,
    })?;
    restrict_dir(path)
}

fn restrict_dir(path: &Path) -> Result<(), HistoryError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).map_err(
            |source| HistoryError::CreateDir {
                path: path.display().to_string(),
                source,
            },
        )?;
    }
    Ok(())
}

fn restrict_file(path: &Path) -> Result<(), HistoryError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).map_err(
            |source| HistoryError::ReadKey {
                path: path.display().to_string(),
                source,
            },
        )?;
    }
    Ok(())
}

fn write_private(path: &Path, bytes: &[u8]) -> Result<(), HistoryError> {
    use std::io::Write;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path).map_err(|source| HistoryError::ReadKey {
        path: path.display().to_string(),
        source,
    })?;
    file.write_all(bytes)
        .map_err(|source| HistoryError::ReadKey {
            path: path.display().to_string(),
            source,
        })?;
    Ok(())
}

fn flag_to_sql(flag: Option<bool>) -> Option<i64> {
    flag.map(i64::from)
}

fn clip(text: &str, limit: usize) -> String {
    if limit == 0 || text.len() <= limit {
        return text.to_string();
    }
    let mut end = limit;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text[..end].to_string()
}

async fn insert_decision(
    pool: &SqlitePool,
    row: &DecisionRow,
    capture_limit: usize,
) -> Result<(), sqlx::Error> {
    use metrics::cost_micros_to_sql;

    let created_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let session_id = row.session_id.as_deref();
    let purpose = row.purpose.as_str();
    let model = row.model.as_str();
    let status = i64::from(row.status);
    let latency_ms = i64::try_from(row.latency_ms).unwrap_or(i64::MAX);
    let user_text = clip(&row.user_text, capture_limit);
    let is_hard = flag_to_sql(row.is_hard);
    let is_easy = flag_to_sql(row.is_easy);
    let is_hard_score = row.is_hard_score;
    let is_easy_score = row.is_easy_score;
    let tools_enough = row.tools_enough.as_deref();
    let complexity = row.complexity;
    let choice_rule = row.choice_rule.as_str();
    let missing_tools = row.missing_tools.as_deref();
    let request_payload = clip(&row.request_payload, capture_limit);
    let response_payload = clip(&row.response_payload, capture_limit);
    let cost_micros = row.cost.map(cost_micros_to_sql);
    let or_cost_micros = row.or_cost.map(cost_micros_to_sql);
    let upstream_cost_micros = row.upstream_cost.map(cost_micros_to_sql);
    let estimated_cost_micros = row.estimated_cost.map(cost_micros_to_sql);
    let cost_source = row.cost_source.as_str();
    sqlx::query!(
        r#"
        INSERT INTO decisions (
            created_at, session_id, purpose, model, status, latency_ms, user_text,
            is_hard, is_easy, is_hard_score, is_easy_score, tools_enough, complexity, choice_rule, missing_tools,
            request_payload, response_payload, cost_micros,
            or_cost_micros, upstream_cost_micros, estimated_cost_micros, cost_source
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        "#,
        created_at,
        session_id,
        purpose,
        model,
        status,
        latency_ms,
        user_text,
        is_hard,
        is_easy,
        is_hard_score,
        is_easy_score,
        tools_enough,
        complexity,
        choice_rule,
        missing_tools,
        request_payload,
        response_payload,
        cost_micros,
        or_cost_micros,
        upstream_cost_micros,
        estimated_cost_micros,
        cost_source
    )
    .execute(pool)
    .await?;
    Ok(())
}

async fn insert_call(
    pool: &SqlitePool,
    call: &FinishedCall,
    store_payloads: bool,
) -> Result<(), sqlx::Error> {
    use metrics::{byte_len_to_sql, cost_micros_to_sql, millis_to_sql, token_count_to_sql};

    let created_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let kind = call.kind.as_str();
    let provider = call.provider.as_str();
    let model = call.model.as_deref();
    let token_hash = call.token_hash.as_deref();
    let message = if store_payloads {
        call.message.as_deref()
    } else {
        None
    };
    let blank = "";
    let input = if store_payloads {
        call.input.as_str()
    } else {
        blank
    };
    let output = if store_payloads {
        call.output.as_str()
    } else {
        blank
    };
    let request_payload = if store_payloads {
        Some(call.request_payload.as_str())
    } else {
        None
    };
    let response_payload = if store_payloads {
        Some(call.response_payload.as_str())
    } else {
        None
    };
    let status = i64::from(call.status);
    let latency_ms = millis_to_sql(call.latency_ms);
    let request_bytes = byte_len_to_sql(call.request_bytes);
    let response_bytes = byte_len_to_sql(call.response_bytes);
    let input_tokens = call.input_tokens.map(token_count_to_sql);
    let output_tokens = call.output_tokens.map(token_count_to_sql);
    let cost_micros = call.cost.map(cost_micros_to_sql);
    let or_cost_micros = call.or_cost.map(cost_micros_to_sql);
    let upstream_cost_micros = call.upstream_cost.map(cost_micros_to_sql);
    let estimated_cost_micros = call.estimated_cost.map(cost_micros_to_sql);
    let cost_source = call.cost_source.as_str();
    let is_byok = call.is_byok.map(i64::from);
    let upstream_provider = call.upstream_provider.as_deref();
    let trimmed_from_tokens = call
        .trimmed_from_tokens
        .map(|n| i64::try_from(n).unwrap_or(i64::MAX));
    let cache_read_tokens = call.cache_read_tokens.map(token_count_to_sql);
    let cache_write_tokens = call.cache_write_tokens.map(token_count_to_sql);
    let generation_id = call.generation_id.as_deref();
    let rerouting = i64::from(call.tier_before.as_deref() != call.tier_after.as_deref());
    let rerouting_reason = call.rerouting_reason.as_deref();
    let session_id = call.session_id.as_deref();
    let parent_session_id = call.parent_session_id.as_deref().or_else(|| {
        call.session_id.as_deref().and_then(|key| {
            key.split_once("#sub:")
                .map(|(parent, _)| parent)
                .filter(|parent| !parent.is_empty())
        })
    });
    let tier_before = call.tier_before.as_deref();
    let tier_after = call.tier_after.as_deref();
    let trigger = call.trigger.as_str();
    let client_model = call.client_model.as_deref();
    let client_has_thinking = call.client_has_thinking.map(i64::from);
    let client_tool_names = call.client_tool_names.as_deref();
    let bg_signal = call.bg_signal.map(i64::from);
    let hk_text_signal = call.hk_text_signal.map(i64::from);
    sqlx::query!(
        r#"
        INSERT INTO calls (
            created_at, kind, provider, model, token_hash, message, input, output,
            request_payload, response_payload,
            status, latency_ms, request_bytes, response_bytes, input_tokens, output_tokens, cost_micros,
            cache_read_tokens, cache_write_tokens, generation_id,
            rerouting, rerouting_reason, session_id, parent_session_id, tier_before, tier_after, trigger,
            or_cost_micros, upstream_cost_micros, estimated_cost_micros, cost_source,
            is_byok, upstream_provider, trimmed_from_tokens,
            client_model, client_has_thinking, client_tool_names, bg_signal, hk_text_signal
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        "#,
        created_at,
        kind,
        provider,
        model,
        token_hash,
        message,
        input,
        output,
        request_payload,
        response_payload,
        status,
        latency_ms,
        request_bytes,
        response_bytes,
        input_tokens,
        output_tokens,
        cost_micros,
        cache_read_tokens,
        cache_write_tokens,
        generation_id,
        rerouting,
        rerouting_reason,
        session_id,
        parent_session_id,
        tier_before,
        tier_after,
        trigger,
        or_cost_micros,
        upstream_cost_micros,
        estimated_cost_micros,
        cost_source,
        is_byok,
        upstream_provider,
        trimmed_from_tokens,
        client_model,
        client_has_thinking,
        client_tool_names,
        bg_signal,
        hk_text_signal
    )
    .execute(pool)
    .await?;
    Ok(())
}
