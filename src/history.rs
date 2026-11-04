use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use hmac::{Hmac, Mac};
use serde_json::Value;
use sha2::Sha256;
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::SqlitePool;
use tokio::sync::Semaphore;

type HmacSha256 = Hmac<Sha256>;

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at INTEGER NOT NULL,
    kind TEXT NOT NULL,
    provider TEXT NOT NULL,
    model TEXT,
    token_hash TEXT,
    message TEXT,
    input TEXT NOT NULL,
    output TEXT NOT NULL,
    status INTEGER NOT NULL,
    latency_ms INTEGER NOT NULL,
    request_bytes INTEGER NOT NULL,
    response_bytes INTEGER NOT NULL,
    input_tokens INTEGER,
    output_tokens INTEGER,
    cost REAL
);
CREATE INDEX IF NOT EXISTS calls_token_hash ON calls(token_hash);
CREATE INDEX IF NOT EXISTS calls_kind_created ON calls(kind, created_at);
"#;

const INSERT_SLOTS: usize = 32;

/// Side store for decisions and LLM calls. A missing pool records nothing.
#[derive(Clone)]
pub struct History {
    pool: Option<SqlitePool>,
    token_key: Vec<u8>,
    capture_limit: usize,
    inserts: Arc<Semaphore>,
}

#[derive(Debug, thiserror::Error)]
pub enum HistoryError {
    #[error("failed to prepare history database at {path}")]
    Open {
        path: String,
        #[source]
        source: sqlx::Error,
    },
    #[error("failed to create history directory {path}")]
    CreateDir {
        path: String,
        #[source]
        source: std::io::Error,
    },
    #[error("failed to read history token key at {path}")]
    ReadKey {
        path: String,
        #[source]
        source: std::io::Error,
    },
}

pub struct CallObserve {
    pub history: History,
    pub kind: &'static str,
    pub provider: &'static str,
}

pub struct FinishedCall {
    pub kind: &'static str,
    pub provider: String,
    pub model: Option<String>,
    pub token_hash: Option<String>,
    pub message: Option<String>,
    pub input: String,
    pub output: String,
    pub status: u16,
    pub latency_ms: u64,
    pub request_bytes: usize,
    pub response_bytes: usize,
    pub input_tokens: Option<i64>,
    pub output_tokens: Option<i64>,
    pub cost: Option<f64>,
}

impl History {
    pub fn disabled() -> Self {
        Self {
            pool: None,
            token_key: Vec::new(),
            capture_limit: 0,
            inserts: Arc::new(Semaphore::new(INSERT_SLOTS)),
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
        let pool = if database_path == "sqlite::memory:" {
            open_pool(database_path).await?
        } else {
            let path = Path::new(database_path);
            if let Some(parent) = path.parent() {
                if !parent.as_os_str().is_empty() {
                    secure_dir(parent)?;
                }
            }
            let url = format!("sqlite://{database_path}?mode=rwc");
            let pool = open_pool(&url).await?;
            restrict_file(path)?;
            sqlx::query("PRAGMA journal_mode=WAL")
                .execute(&pool)
                .await
                .map_err(|source| HistoryError::Open {
                    path: database_path.to_string(),
                    source,
                })?;
            pool
        };
        sqlx::raw_sql(SCHEMA)
            .execute(&pool)
            .await
            .map_err(|source| HistoryError::Open {
                path: database_path.to_string(),
                source,
            })?;
        Ok(Self {
            pool: Some(pool),
            token_key: key,
            capture_limit,
            inserts: Arc::new(Semaphore::new(INSERT_SLOTS)),
        })
    }

    pub fn enabled(&self) -> bool {
        self.pool.is_some()
    }

    pub fn pool(&self) -> Option<&SqlitePool> {
        self.pool.as_ref()
    }

    /// Keyed hash of the caller credential. Equal secrets match; the raw secret is not stored.
    pub fn token_hash(&self, secret: &str) -> String {
        let mut mac =
            HmacSha256::new_from_slice(&self.token_key).expect("hmac accepts any key length");
        mac.update(secret.as_bytes());
        hex_encode(&mac.finalize().into_bytes())
    }

    pub fn record(&self, call: FinishedCall) {
        let Some(pool) = self.pool.clone() else {
            return;
        };
        let Ok(permit) = self.inserts.clone().try_acquire_owned() else {
            tracing::warn!(
                kind = call.kind,
                provider = %call.provider,
                "history insert skipped; queue full"
            );
            return;
        };
        tokio::spawn(async move {
            let _permit = permit;
            let captured_bytes = call.request_bytes.saturating_add(call.response_bytes);
            match insert_call(&pool, &call).await {
                Ok(()) => {
                    tracing::info!(
                        kind = call.kind,
                        provider = %call.provider,
                        model = call.model.as_deref().unwrap_or(""),
                        status = call.status,
                        latency_ms = call.latency_ms,
                        request_bytes = call.request_bytes,
                        response_bytes = call.response_bytes,
                        captured_bytes,
                        input_tokens = call.input_tokens,
                        output_tokens = call.output_tokens,
                        cost = call.cost,
                        "call stored"
                    );
                }
                Err(err) => {
                    tracing::warn!(
                        %err,
                        kind = call.kind,
                        provider = %call.provider,
                        status = call.status,
                        "history insert failed"
                    );
                }
            }
        });
    }
}

async fn open_pool(url: &str) -> Result<SqlitePool, HistoryError> {
    let options: SqliteConnectOptions = url.parse().map_err(|source| HistoryError::Open {
        path: url.to_string(),
        source,
    })?;
    let options = options.create_if_missing(true);
    let max_connections = if url.contains("memory") { 2 } else { 5 };
    SqlitePoolOptions::new()
        .max_connections(max_connections)
        .acquire_timeout(Duration::from_secs(5))
        .connect_with(options)
        .await
        .map_err(|source| HistoryError::Open {
            path: url.to_string(),
            source,
        })
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

async fn insert_call(pool: &SqlitePool, call: &FinishedCall) -> Result<(), sqlx::Error> {
    let created_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    sqlx::query(
        r#"
        INSERT INTO calls (
            created_at, kind, provider, model, token_hash, message, input, output,
            status, latency_ms, request_bytes, response_bytes, input_tokens, output_tokens, cost
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        "#,
    )
    .bind(created_at)
    .bind(call.kind)
    .bind(&call.provider)
    .bind(&call.model)
    .bind(&call.token_hash)
    .bind(&call.message)
    .bind(&call.input)
    .bind(&call.output)
    .bind(i64::from(call.status))
    .bind(call.latency_ms as i64)
    .bind(call.request_bytes as i64)
    .bind(call.response_bytes as i64)
    .bind(call.input_tokens)
    .bind(call.output_tokens)
    .bind(call.cost)
    .execute(pool)
    .await?;
    Ok(())
}

pub fn token_from_headers(headers: &axum::http::HeaderMap) -> String {
    if let Some(value) = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
    {
        let secret = value
            .strip_prefix("Bearer ")
            .or_else(|| value.strip_prefix("bearer "))
            .unwrap_or(value);
        if !secret.is_empty() {
            return secret.to_string();
        }
    }
    if let Some(value) = headers.get("x-api-key").and_then(|v| v.to_str().ok()) {
        if !value.is_empty() {
            return value.to_string();
        }
    }
    String::new()
}

pub fn describe_input(body: &str) -> (Option<String>, Option<String>) {
    let Ok(value) = serde_json::from_str::<Value>(body) else {
        return (None, None);
    };
    let model = value
        .get("model")
        .and_then(Value::as_str)
        .map(str::to_string);
    let message = message_from_value(&value);
    (model, message)
}

fn message_from_value(value: &Value) -> Option<String> {
    if let Some(messages) = value.get("messages").and_then(Value::as_array) {
        for message in messages.iter().rev() {
            if message.get("role").and_then(Value::as_str) == Some("user") {
                if let Some(text) = content_text(message.get("content")) {
                    return Some(text);
                }
            }
        }
    }
    content_text(value.get("input")).or_else(|| content_text(value.get("prompt")))
}

fn content_text(content: Option<&Value>) -> Option<String> {
    let content = content?;
    if let Some(text) = content.as_str() {
        return Some(text.to_string());
    }
    if let Some(parts) = content.as_array() {
        let mut text = String::new();
        for part in parts {
            if let Some(piece) = part.get("text").and_then(Value::as_str) {
                text.push_str(piece);
            } else if let Some(piece) = part.as_str() {
                text.push_str(piece);
            }
        }
        if !text.is_empty() {
            return Some(text);
        }
    }
    None
}

pub fn usage_from_output(output: &str) -> (Option<i64>, Option<i64>, Option<f64>) {
    let mut found = (None, None, None);
    merge_usage(&mut found, output);
    for line in output.lines() {
        let line = line.trim();
        let payload = line.strip_prefix("data:").map(str::trim).unwrap_or("");
        if payload.is_empty() || payload == "[DONE]" {
            continue;
        }
        merge_usage(&mut found, payload);
    }
    found
}

fn merge_usage(found: &mut (Option<i64>, Option<i64>, Option<f64>), raw: &str) {
    let Ok(value) = serde_json::from_str::<Value>(raw) else {
        return;
    };
    apply_usage(found, value.get("usage"));
    apply_usage(
        found,
        value
            .get("message")
            .and_then(|message| message.get("usage")),
    );
}

fn apply_usage(found: &mut (Option<i64>, Option<i64>, Option<f64>), usage: Option<&Value>) {
    let Some(usage) = usage else {
        return;
    };
    if let Some(input) =
        json_i64(usage.get("prompt_tokens")).or_else(|| json_i64(usage.get("input_tokens")))
    {
        found.0 = Some(input);
    }
    if let Some(output) =
        json_i64(usage.get("completion_tokens")).or_else(|| json_i64(usage.get("output_tokens")))
    {
        found.1 = Some(output);
    }
    if let Some(cost) = usage.get("cost").and_then(Value::as_f64) {
        found.2 = Some(cost);
    }
}

fn json_i64(value: Option<&Value>) -> Option<i64> {
    value.and_then(|v| {
        v.as_i64()
            .or_else(|| v.as_u64().map(|n| n as i64))
            .or_else(|| v.as_f64().map(|n| n as i64))
    })
}

fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0x0f) as usize] as char);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn same_secret_matches_and_raw_secret_is_not_the_hash() {
        let history = History {
            pool: None,
            token_key: b"server-key".to_vec(),
            capture_limit: usize::MAX,
            inserts: Arc::new(Semaphore::new(1)),
        };
        let left = history.token_hash("sk-user");
        let right = history.token_hash("sk-user");
        assert_eq!(left, right);
        assert_ne!(history.token_hash("sk-other"), left);
        assert!(!left.contains("sk-user"));
    }

    #[test]
    fn describe_input_reads_model_and_last_user_message() {
        let (model, message) = describe_input(
            r#"{"model":"gpt-test","messages":[{"role":"user","content":"hello"},{"role":"assistant","content":"hi"},{"role":"user","content":[{"type":"text","text":"again"}]}]}"#,
        );
        assert_eq!(model.as_deref(), Some("gpt-test"));
        assert_eq!(message.as_deref(), Some("again"));
    }

    #[test]
    fn usage_reads_sse_and_cost() {
        let output = "data: {\"choices\":[]}\n\ndata: {\"usage\":{\"prompt_tokens\":3,\"completion_tokens\":4,\"cost\":0.25}}\n\ndata: [DONE]\n";
        let (input, output_tokens, cost) = usage_from_output(output);
        assert_eq!(input, Some(3));
        assert_eq!(output_tokens, Some(4));
        assert_eq!(cost, Some(0.25));
    }

    #[test]
    fn usage_reads_anthropic_message_events() {
        let output = "data: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":11,\"output_tokens\":1}}}\n\ndata: {\"type\":\"message_delta\",\"usage\":{\"output_tokens\":9}}\n";
        let (input, output_tokens, cost) = usage_from_output(output);
        assert_eq!(input, Some(11));
        assert_eq!(output_tokens, Some(9));
        assert_eq!(cost, None);
    }
}
