use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use hmac::{Hmac, Mac};
use sha2::Sha256;
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::SqlitePool;
use tokio::sync::Semaphore;

mod payload;

pub use payload::{describe_input, token_from_headers, usage_from_output};

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
        hex::encode(mac.finalize().into_bytes())
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
