use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
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
mod error;
mod metrics;
mod payload;

pub use call::{CallObserve, DecisionRow, FinishedCall};
pub use call_kind::CallKind;
pub use call_provider::CallProvider;
pub use error::HistoryError;
pub use metrics::{CostMicros, Millis, TokenCount};
pub use payload::{
    describe_input, is_subagent, request_payload, response_payload, token_from_headers,
    usage_from_output, usage_from_parts, ParsedUsage,
};

type HmacSha256 = Hmac<Sha256>;

const INSERT_SLOTS: usize = 32;

#[derive(Clone)]
pub struct History {
    pool: Option<SqlitePool>,
    token_key: Vec<u8>,
    capture_limit: usize,
    inserts: Arc<Semaphore>,
    inflight: Arc<AtomicUsize>,
    idle: Arc<Notify>,
}

impl History {
    pub fn disabled() -> Self {
        Self {
            pool: None,
            token_key: Vec::new(),
            capture_limit: 0,
            inserts: Arc::new(Semaphore::new(INSERT_SLOTS)),
            inflight: Arc::new(AtomicUsize::new(0)),
            idle: Arc::new(Notify::new()),
        }
    }

    pub fn capture_limit(&self) -> usize {
        self.capture_limit
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
            inserts: Arc::new(Semaphore::new(INSERT_SLOTS)),
            inflight: Arc::new(AtomicUsize::new(0)),
            idle: Arc::new(Notify::new()),
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
        tokio::spawn(async move {
            let Ok(Ok(permit)) =
                tokio::time::timeout(Duration::from_secs(5), inserts.acquire_owned()).await
            else {
                tracing::warn!(
                    choice_rule = %row.choice_rule,
                    "decision insert skipped; queue wait timed out"
                );
                return;
            };
            inflight.fetch_add(1, Ordering::AcqRel);
            struct Done(Arc<AtomicUsize>, Arc<Notify>);
            impl Drop for Done {
                fn drop(&mut self) {
                    if self.0.fetch_sub(1, Ordering::AcqRel) == 1 {
                        self.1.notify_waiters();
                    }
                }
            }
            let _done = Done(inflight, idle);
            let _permit = permit;
            if let Err(err) = insert_decision(&pool, &row, limit).await {
                tracing::warn!(%err, choice_rule = %row.choice_rule, "decision insert failed");
            }
        });
    }

    pub fn record(&self, call: FinishedCall) {
        let Some(pool) = self.pool.clone() else {
            return;
        };
        let inserts = self.inserts.clone();
        let inflight = self.inflight.clone();
        let idle = self.idle.clone();
        tokio::spawn(async move {
            let permit =
                match tokio::time::timeout(Duration::from_secs(5), inserts.acquire_owned()).await {
                    Ok(Ok(permit)) => permit,
                    Ok(Err(_)) => {
                        tracing::warn!(
                            kind = %call.kind,
                            provider = %call.provider,
                            "history insert skipped; insert pool closed"
                        );
                        return;
                    }
                    Err(_) => {
                        tracing::warn!(
                            kind = %call.kind,
                            provider = %call.provider,
                            "history insert skipped; queue wait timed out"
                        );
                        return;
                    }
                };
            inflight.fetch_add(1, Ordering::AcqRel);
            struct Done(Arc<AtomicUsize>, Arc<Notify>);
            impl Drop for Done {
                fn drop(&mut self) {
                    if self.0.fetch_sub(1, Ordering::AcqRel) == 1 {
                        self.1.notify_waiters();
                    }
                }
            }
            let _done = Done(inflight, idle);
            let _permit = permit;
            let captured_bytes = call.request_bytes.saturating_add(call.response_bytes);
            match insert_call(&pool, &call).await {
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
                        "call stored"
                    );
                }
                Err(err) => {
                    tracing::warn!(
                        %err,
                        kind = %call.kind,
                        provider = %call.provider,
                        status = call.status,
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
    sqlx::query!(
        r#"
        INSERT INTO decisions (
            created_at, session_id, purpose, model, status, latency_ms, user_text,
            is_hard, is_easy, is_hard_score, is_easy_score, tools_enough, complexity, choice_rule, missing_tools,
            request_payload, response_payload
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        response_payload
    )
    .execute(pool)
    .await?;
    Ok(())
}

async fn insert_call(pool: &SqlitePool, call: &FinishedCall) -> Result<(), sqlx::Error> {
    use metrics::{byte_len_to_sql, cost_micros_to_sql, millis_to_sql, token_count_to_sql};

    let created_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let kind = call.kind.as_str();
    let provider = call.provider.as_str();
    let model = call.model.as_deref();
    let token_hash = call.token_hash.as_deref();
    let message = call.message.as_deref();
    let input = call.input.as_str();
    let output = call.output.as_str();
    let request_payload = call.request_payload.as_str();
    let response_payload = call.response_payload.as_str();
    let status = i64::from(call.status);
    let latency_ms = millis_to_sql(call.latency_ms);
    let request_bytes = byte_len_to_sql(call.request_bytes);
    let response_bytes = byte_len_to_sql(call.response_bytes);
    let input_tokens = call.input_tokens.map(token_count_to_sql);
    let output_tokens = call.output_tokens.map(token_count_to_sql);
    let cost_micros = call.cost.map(cost_micros_to_sql);
    let rerouting = call.rerouting;
    let rerouting_reason = call.rerouting_reason.as_deref();
    sqlx::query!(
        r#"
        INSERT INTO calls (
            created_at, kind, provider, model, token_hash, message, input, output,
            request_payload, response_payload,
            status, latency_ms, request_bytes, response_bytes, input_tokens, output_tokens, cost_micros,
            rerouting, rerouting_reason
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        rerouting,
        rerouting_reason,
    )
    .execute(pool)
    .await?;
    Ok(())
}
