use std::path::Path;
use std::time::Duration;

use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous};
use sqlx::SqlitePool;

use super::error::HistoryError;
use super::secure_dir;

pub async fn open_pool(database_path: &str) -> Result<SqlitePool, HistoryError> {
    let memory = database_path == "sqlite::memory:";
    let options = if memory {
        memory_options(database_path)?
    } else {
        file_options(database_path)?
    };
    let max_connections = if memory { 2 } else { 5 };
    let pool = SqlitePoolOptions::new()
        .max_connections(max_connections)
        .acquire_timeout(Duration::from_secs(5))
        .connect_with(options)
        .await
        .map_err(|source| HistoryError::Open {
            path: database_path.to_string(),
            source,
        })?;
    sqlx::migrate!("./migrations")
        .run(&pool)
        .await
        .map_err(|source| HistoryError::Migrate {
            path: database_path.to_string(),
            source,
        })?;
    Ok(pool)
}

fn memory_options(database_path: &str) -> Result<SqliteConnectOptions, HistoryError> {
    database_path
        .parse::<SqliteConnectOptions>()
        .map(|opts| opts.busy_timeout(Duration::from_secs(5)))
        .map_err(|source| HistoryError::Open {
            path: database_path.to_string(),
            source,
        })
}

fn file_options(database_path: &str) -> Result<SqliteConnectOptions, HistoryError> {
    let path = Path::new(database_path);
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            secure_dir(parent)?;
        }
    }
    Ok(SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(true)
        .journal_mode(SqliteJournalMode::Wal)
        .synchronous(SqliteSynchronous::Normal)
        .busy_timeout(Duration::from_secs(5)))
}
