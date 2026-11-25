use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::catalogue::CatalogueSnapshot;

const CACHE_VERSION: u32 = 1;
pub const CACHE_FILE_NAME: &str = "prices-catalogue.json";

#[derive(Serialize, Deserialize)]
struct CacheFile {
    version: u32,
    #[serde(flatten)]
    snapshot: CatalogueSnapshot,
}

/// The default cache file: beside the history database (`<dir of database_path>/prices-catalogue.json`); `None` for an
/// in-memory database.
pub fn default_cache_path(database_path: &str) -> Option<PathBuf> {
    if database_path.contains(":memory:") {
        return None;
    }
    let bare = database_path
        .strip_prefix("sqlite://")
        .or_else(|| database_path.strip_prefix("sqlite:"))
        .unwrap_or(database_path);
    let dir = Path::new(bare)
        .parent()
        .filter(|dir| !dir.as_os_str().is_empty());
    Some(match dir {
        Some(dir) => dir.join(CACHE_FILE_NAME),
        None => PathBuf::from(CACHE_FILE_NAME),
    })
}

/// The last saved catalogue, or `None` when the file is missing, unreadable or of another version.
pub fn load(path: &Path) -> Option<CatalogueSnapshot> {
    let text = std::fs::read_to_string(path).ok()?;
    let file: CacheFile = serde_json::from_str(&text)
        .map_err(
            |err| tracing::warn!(path = %path.display(), %err, "ignoring unreadable price cache"),
        )
        .ok()?;
    (file.version == CACHE_VERSION && !file.snapshot.models.is_empty()).then_some(file.snapshot)
}

/// Writes the snapshot through a temporary file and a rename, so a crash never leaves half a file.
pub fn save(path: &Path, snapshot: &CatalogueSnapshot) -> std::io::Result<()> {
    if let Some(dir) = path.parent().filter(|dir| !dir.as_os_str().is_empty()) {
        std::fs::create_dir_all(dir)?;
    }
    let body = serde_json::to_vec(&CacheFile {
        version: CACHE_VERSION,
        snapshot: snapshot.clone(),
    })
    .map_err(std::io::Error::other)?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, body)?;
    std::fs::rename(&tmp, path)
}
