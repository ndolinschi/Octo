//! Preparing the bundled Octo router: its config directory, its client key, its pid file name.
//!
//! The router (`apps/router`) is configured only through TOML fragments in a directory named by `OCTO_CONFIG` (there is
//! no flag or environment variable for the bind address, the client key or the database path), and it needs `[server]`
//! and `[limits]`; every other section has built-in defaults. So the shell writes three fragments per launch
//! (`server.toml`, `limits.toml`, `history.toml`) into `{router dir}/config`, then starts the binary with
//! `OCTO_CONFIG` pointing there. The client key therefore lives in a file in the app data directory (mode 0600 on
//! Unix), never in a command line.

use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};

pub const LOG_NAME: &str = "router.log";
pub const PID_NAME: &str = "router.pid";
/// Names the router process can have (`ps -o comm=`), for the leftover cleanup.
pub const PROCESS_NAMES: &[&str] = &["octo", "octo.exe"];

/// The HTTP body limit written into `limits.toml` (the router's shipped default is 10 MiB; agent contexts are larger).
pub const MAX_BODY_BYTES: u64 = 32 * 1024 * 1024;

/// A random 256-bit key as 64 hex characters: `/dev/urandom` on Unix, hasher seeds from the OS elsewhere.
pub fn generate_key() -> String {
    let mut bytes = [0u8; 32];
    let from_os = std::fs::File::open("/dev/urandom")
        .and_then(|mut f| f.read_exact(&mut bytes))
        .is_ok();
    if !from_os {
        use std::hash::{BuildHasher, Hasher};
        for chunk in bytes.chunks_mut(8) {
            // `RandomState` is seeded from the operating system's randomness.
            let mut h = std::collections::hash_map::RandomState::new().build_hasher();
            h.write_u128(
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_nanos())
                    .unwrap_or(0),
            );
            h.write_u32(std::process::id());
            chunk.copy_from_slice(&h.finish().to_le_bytes());
        }
    }
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// A TOML basic string.
fn toml_str(s: &str) -> String {
    let mut out = String::from("\"");
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

pub fn server_toml(port: u16, client_key: &str) -> String {
    format!(
        "[server]\nbind_addr = \"127.0.0.1:{port}\"\nallow_remote = false\nclient_auth_key = {}\n",
        toml_str(client_key)
    )
}

pub fn limits_toml() -> String {
    format!("[limits]\nmax_body_bytes = {MAX_BODY_BYTES}\n")
}

pub fn history_toml(database: &Path) -> String {
    format!(
        "[history]\ndatabase_path = {}\n",
        toml_str(&database.to_string_lossy())
    )
}

/// Where the fragments go: `{router dir}/config`.
pub fn config_dir(router_dir: &Path) -> PathBuf {
    router_dir.join("config")
}

/// The history database: `{router dir}/history.sqlite` (the router puts its token-hash key `.key` beside it).
pub fn database_path(router_dir: &Path) -> PathBuf {
    router_dir.join("history.sqlite")
}

/// Writes the three fragments (replacing earlier ones). `server.toml` holds the key, so it is created 0600 on Unix.
pub fn write_config(router_dir: &Path, port: u16, client_key: &str) -> io::Result<PathBuf> {
    let dir = config_dir(router_dir);
    std::fs::create_dir_all(&dir)?;
    write_private(&dir.join("server.toml"), &server_toml(port, client_key))?;
    std::fs::write(dir.join("limits.toml"), limits_toml())?;
    std::fs::write(
        dir.join("history.toml"),
        history_toml(&database_path(router_dir)),
    )?;
    Ok(dir)
}

fn write_private(path: &Path, text: &str) -> io::Result<()> {
    let _ = std::fs::remove_file(path);
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    opts.open(path)?.write_all(text.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_are_64_hex_chars_and_differ() {
        let a = generate_key();
        let b = generate_key();
        assert_eq!(a.len(), 64);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, b);
    }

    #[test]
    fn fragments_are_valid_toml_shaped_text() {
        assert_eq!(
            server_toml(4711, "abc"),
            "[server]\nbind_addr = \"127.0.0.1:4711\"\nallow_remote = false\nclient_auth_key = \"abc\"\n"
        );
        assert!(limits_toml().contains("max_body_bytes = 33554432"));
        assert_eq!(
            history_toml(Path::new("/d/router/history.sqlite")),
            "[history]\ndatabase_path = \"/d/router/history.sqlite\"\n"
        );
        // Backslashes (Windows) and quotes are escaped.
        assert!(history_toml(Path::new("C:\\Users\\o\\h.sqlite")).contains("C:\\\\Users\\\\o"));
        assert_eq!(toml_str("a\"b"), "\"a\\\"b\"");
    }

    #[test]
    fn write_config_creates_the_directory_and_replaces_old_files() {
        let d = std::env::temp_dir().join(format!("octo-routercfg-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        let dir = write_config(&d, 1111, "k1").unwrap();
        let dir2 = write_config(&d, 2222, "k2").unwrap();
        assert_eq!(dir, dir2);
        let server = std::fs::read_to_string(dir.join("server.toml")).unwrap();
        assert!(server.contains("127.0.0.1:2222") && server.contains("\"k2\""));
        assert!(dir.join("limits.toml").is_file() && dir.join("history.toml").is_file());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(dir.join("server.toml"))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o077, 0, "the key file must be private");
        }
        let _ = std::fs::remove_dir_all(d);
    }
}
