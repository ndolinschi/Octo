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
