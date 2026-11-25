//! The few settings the shell itself needs from `{app data}/harness/harness.env`.
//!
//! The harness owns and writes that file (design P2/P7); the shell only reads three router keys from it before it
//! decides what to start. The grammar matches the harness's reader: `KEY=VALUE` lines, `#` comment lines, an optional
//! `export ` prefix, one pair of surrounding quotes, no inline comments. Tolerant by design: a missing or unreadable
//! file, or a malformed line, never fails a start (the harness reports problems with the file itself). Values are
//! never logged and never appear in `Debug` output.

use std::fmt;
use std::path::Path;

pub const KEY_ENABLED: &str = "OCTO_ROUTER_ENABLED";
pub const KEY_UPSTREAM: &str = "OCTO_ROUTER_UPSTREAM_KEY";
pub const KEY_BASE_URL: &str = "OCTO_ROUTER_BASE_URL";

/// Parses `harness.env` text into (name, value) pairs in file order. Later duplicates win in [`lookup`].
pub fn parse_env(text: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let line = line.strip_prefix("export ").map(str::trim).unwrap_or(line);
        let Some((name, value)) = line.split_once('=') else {
            continue;
        };
        let name = name.trim();
        if name.is_empty() || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
            continue;
        }
        out.push((name.to_string(), unquote(value.trim()).to_string()));
    }
    out
}

fn unquote(v: &str) -> &str {
    let b = v.as_bytes();
    if b.len() >= 2 && (b[0] == b'"' || b[0] == b'\'') && b[b.len() - 1] == b[0] {
        return &v[1..v.len() - 1];
    }
    v
}

fn lookup<'a>(pairs: &'a [(String, String)], name: &str) -> Option<&'a str> {
    pairs
        .iter()
        .rev()
        .find(|(k, _)| k == name)
        .map(|(_, v)| v.as_str())
}

/// What `harness.env` says about the router.
#[derive(Clone, Default, PartialEq, Eq)]
pub struct RouterSettings {
    /// `OCTO_ROUTER_ENABLED` is `1` (also `true`/`yes`/`on`); default off.
    pub enabled: bool,
    /// `OCTO_ROUTER_UPSTREAM_KEY`, when non-empty.
    pub upstream_key: Option<String>,
    /// `OCTO_ROUTER_BASE_URL`, when non-empty: an external router; no bundled one is started.
    pub base_url: Option<String>,
}

impl fmt::Debug for RouterSettings {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("RouterSettings")
            .field("enabled", &self.enabled)
            .field("upstream_key", &self.upstream_key.as_ref().map(|_| "<set>"))
            .field("base_url", &self.base_url)
            .finish()
    }
}

impl RouterSettings {
    pub fn from_text(text: &str) -> Self {
        let pairs = parse_env(text);
        let non_empty = |name: &str| {
            lookup(&pairs, name)
                .map(str::trim)
                .filter(|v| !v.is_empty())
                .map(str::to_string)
        };
        let enabled = lookup(&pairs, KEY_ENABLED)
            .map(|v| {
                matches!(
                    v.trim().to_ascii_lowercase().as_str(),
                    "1" | "true" | "yes" | "on"
                )
            })
            .unwrap_or(false);
        Self {
            enabled,
            upstream_key: non_empty(KEY_UPSTREAM),
            base_url: non_empty(KEY_BASE_URL).map(|u| u.trim_end_matches('/').to_string()),
        }
    }

    /// Reads the file; a missing or unreadable one means all defaults (router off).
    pub fn load(path: &Path) -> Self {
        std::fs::read_to_string(path)
            .map(|t| Self::from_text(&t))
            .unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn grammar_matches_the_harness_reader() {
        let text = "# comment\n\nOCTO_ROUTER_ENABLED=1\nexport OCTO_ROUTER_UPSTREAM_KEY=\"sk-or-v1-abc\"\n  OCTO_ROUTER_BASE_URL = 'http://r:1/autoroute/'  \nbad line\n1BAD-NAME=x\nOTHER=a=b\n";
        let pairs = parse_env(text);
        assert_eq!(pairs.len(), 4, "{pairs:?}"); // `1BAD-NAME` is not a name, `bad line` has no `=`
        assert_eq!(lookup(&pairs, "OTHER"), Some("a=b"));
        let s = RouterSettings::from_text(text);
        assert!(s.enabled);
        assert_eq!(s.upstream_key.as_deref(), Some("sk-or-v1-abc"));
        assert_eq!(s.base_url.as_deref(), Some("http://r:1/autoroute"));
    }

    #[test]
    fn defaults_are_off_and_empty() {
        assert_eq!(RouterSettings::from_text(""), RouterSettings::default());
        assert!(!RouterSettings::default().enabled);
        let s = RouterSettings::from_text(
            "OCTO_ROUTER_ENABLED=0\nOCTO_ROUTER_UPSTREAM_KEY=\nOCTO_ROUTER_BASE_URL=\"\"\n",
        );
        assert!(!s.enabled && s.upstream_key.is_none() && s.base_url.is_none());
        assert!(!RouterSettings::from_text("OCTO_ROUTER_ENABLED=maybe").enabled);
        assert!(RouterSettings::from_text("OCTO_ROUTER_ENABLED=True").enabled);
    }

    #[test]
    fn the_last_assignment_wins_and_quotes_must_pair() {
        let s = RouterSettings::from_text(
            "OCTO_ROUTER_ENABLED=0\nOCTO_ROUTER_ENABLED=1\nOCTO_ROUTER_UPSTREAM_KEY=\"half\n",
        );
        assert!(s.enabled);
        assert_eq!(s.upstream_key.as_deref(), Some("\"half"));
    }

    #[test]
    fn a_missing_file_is_all_defaults_and_debug_hides_the_key() {
        assert_eq!(
            RouterSettings::load(Path::new("/nonexistent/harness.env")),
            RouterSettings::default()
        );
        let s = RouterSettings::from_text("OCTO_ROUTER_UPSTREAM_KEY=sk-secret-value");
        let shown = format!("{s:?}");
        assert!(!shown.contains("sk-secret-value"), "{shown}");
    }
}
