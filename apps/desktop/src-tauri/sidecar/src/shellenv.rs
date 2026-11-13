//! Login-shell `PATH` and environment resolution.
//!
//! A GUI app started from Finder does not inherit the user's shell `PATH`, but the agents the harness drives
//! (`npx`, `claude`, `copilot`, ...) live in directories only the shell profile adds. So we ask the user's own
//! shell, interactively and as a login shell, to print it between markers (profiles print banners, so the output
//! cannot be taken as is), with a short timeout (a hanging profile must not block start-up).
//!
//! The same shell invocation also prints its whole environment (`env -0`, NUL separated) in a second marked block.
//! Only an allow-list of names is forwarded to the harness ([`FORWARD_EXACT`], [`FORWARD_PREFIXES`]: locale, XDG
//! dirs, `SSH_AUTH_SOCK`, tool homes, proxy and CA settings, `TMPDIR`), and a name that looks like a secret
//! ([`DENY_WORDS`]) is never forwarded, whatever the list says. Values are never logged.

use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

pub const START: &str = "__OCTO_PATH_START__";
pub const END: &str = "__OCTO_PATH_END__";
pub const ENV_START: &str = "__OCTO_ENV_START__";
pub const ENV_END: &str = "__OCTO_ENV_END__";

/// Names forwarded from the login shell when it has them (exact, case-sensitive). `PATH` is handled apart (it is
/// merged with the inherited one and always sent); it is not in this list. `HOME` is deliberately absent.
pub const FORWARD_EXACT: &[&str] = &[
    "LANG",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_STATE_HOME",
    "XDG_CACHE_HOME",
    "SSH_AUTH_SOCK",
    "NVM_DIR",
    "BUN_INSTALL",
    "PNPM_HOME",
    "VOLTA_HOME",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
    "SSL_CERT_FILE",
    "NODE_EXTRA_CA_CERTS",
    "TMPDIR",
    "SHELL",
    "USER",
    "LOGNAME",
    "TERM",
];

/// Forwarded by prefix: `LC_ALL`, `LC_CTYPE`, ...
pub const FORWARD_PREFIXES: &[&str] = &["LC_"];

/// A name containing any of these (case-insensitive) is never forwarded, even if an allow-list names it.
/// (`SSH_AUTH_SOCK` is a socket path and does not match.)
pub const DENY_WORDS: &[&str] = &["KEY", "TOKEN", "SECRET", "PASSWORD", "PASSWD", "CREDENTIAL"];

pub fn is_denied(name: &str) -> bool {
    let upper = name.to_ascii_uppercase();
    DENY_WORDS.iter().any(|w| upper.contains(w))
}

fn is_listed(name: &str) -> bool {
    FORWARD_EXACT.contains(&name) || FORWARD_PREFIXES.iter().any(|p| name.starts_with(p))
}

/// Whether `name` may go to the harness: on the allow-list and not secret-looking. `PATH` is not decided here.
pub fn forwardable(name: &str) -> bool {
    !is_denied(name) && is_listed(name)
}

/// The generic filter behind [`forwardable`], with the allow-list passed in so a test can prove that the deny
/// words win over any list: keeps entries that `allow` accepts and that are not denied, drops empty values and
/// names in `user_set` (the user's own `harness.env` decides those); the first occurrence of a name wins.
pub fn select_forwarded(
    vars: &[(String, String)],
    allow: impl Fn(&str) -> bool,
    user_set: &[String],
) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    for (k, v) in vars {
        if k == "PATH"
            || v.is_empty()
            || v.contains(['\0', '\u{FFFD}'])
            || is_denied(k)
            || !allow(k)
            || user_set.iter().any(|u| u == k)
            || out.iter().any(|(n, _)| n == k)
        {
            continue;
        }
        out.push((k.clone(), v.clone()));
    }
    out
}

/// Parses the `env -0` block: the last complete marker pair wins; entries are split at NUL, then at the first `=`
/// (values may hold `=` and newlines). Entries without `=` or with an invalid name are skipped.
pub fn parse_env_block(output: &str) -> Vec<(String, String)> {
    let Some(start) = output.rfind(ENV_START) else {
        return Vec::new();
    };
    let rest = &output[start + ENV_START.len()..];
    let Some(end) = rest.find(ENV_END) else {
        return Vec::new();
    };
    rest[..end]
        .split('\0')
        .filter_map(|entry| {
            let (name, value) = entry.split_once('=')?;
            let ok = !name.is_empty()
                && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
                && !name.starts_with(|c: char| c.is_ascii_digit());
            ok.then(|| (name.to_string(), value.to_string()))
        })
        .collect()
}

/// What the harness is started with from the login shell.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Resolved {
    /// Never empty.
    pub path: String,
    /// Allow-listed, non-secret variables, in the shell's order; empty on the fallback.
    pub vars: Vec<(String, String)>,
}

impl Resolved {
    /// The names forwarded (never the values), for the log.
    pub fn names(&self) -> Vec<&str> {
        self.vars.iter().map(|(k, _)| k.as_str()).collect()
    }
}
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(3);

/// Directories where user-installed CLIs usually are, relative entries use `home`.
pub fn common_dirs(home: Option<&str>) -> Vec<String> {
    let mut v: Vec<String> = [
        "/opt/homebrew/bin",
        "/opt/homebrew/sbin",
        "/usr/local/bin",
        "/usr/local/sbin",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    if let Some(h) = home.filter(|h| !h.is_empty()) {
        let h = h.trim_end_matches('/');
        for rel in [
            ".local/bin",
            ".cargo/bin",
            "go/bin",
            ".bun/bin",
            ".volta/bin",
            ".npm-global/bin",
            ".deno/bin",
        ] {
            v.push(format!("{h}/{rel}"));
        }
    }
    v
}

/// Extracts the PATH printed between the markers. The last complete marker pair wins (a banner could echo the
/// command line); the value must be a single non-empty line of absolute entries.
pub fn parse_delimited_path(output: &str) -> Option<String> {
    let start = output.rfind(START)?;
    let rest = &output[start + START.len()..];
    let end = rest.find(END)?;
    let value = rest[..end].trim();
    if value.is_empty() || value.contains(['\n', '\r', '\0']) {
        return None;
    }
    // Every entry that is not empty must be absolute; an unexpanded `$PATH` or garbage means the shell did not
    // do what we asked.
    if value
        .split(':')
        .any(|e| !e.is_empty() && !e.starts_with('/'))
    {
        return None;
    }
    Some(value.to_string())
}

/// Joins entries, dropping empty ones and later duplicates, keeping order.
pub fn merge_paths(parts: &[&str]) -> String {
    let mut seen: Vec<&str> = Vec::new();
    for part in parts {
        for entry in part.split(':') {
            if !entry.is_empty() && !seen.contains(&entry) {
                seen.push(entry);
            }
        }
    }
    seen.join(":")
}

/// The fallback when the login shell cannot be asked: the inherited PATH plus the common dirs.
pub fn fallback_path(inherited: &str, home: Option<&str>) -> String {
    let common = common_dirs(home).join(":");
    merge_paths(&[inherited, &common])
}

/// The PATH the harness should get: the login shell's (then anything the app inherited that the shell did not
/// list), or the fallback. Never empty.
pub fn resolve_path(
    shell: Option<&str>,
    inherited: &str,
    home: Option<&str>,
    timeout: Duration,
) -> String {
    resolve(shell, inherited, home, timeout, &[]).path
}

/// One login-shell run gives the PATH (as before) and the allow-listed environment. `user_set` lists the names
/// the user set in `harness.env`: none of those is forwarded (the harness reads that file itself, and a value in
/// its process environment would shadow the file). For any other name the login shell's value wins over the
/// app's own. If the shell cannot be asked, fails or times out: exactly the old fallback PATH and no extras.
pub fn resolve(
    shell: Option<&str>,
    inherited: &str,
    home: Option<&str>,
    timeout: Duration,
    user_set: &[String],
) -> Resolved {
    if let Some(shell) = shell.filter(|s| !s.is_empty()) {
        if let Some(out) = run_login_shell(shell, timeout) {
            if let Some(login) = parse_delimited_path(&out) {
                return Resolved {
                    path: merge_paths(&[&login, inherited]),
                    vars: select_forwarded(&parse_env_block(&out), is_listed, user_set),
                };
            }
        }
    }
    let fb = fallback_path(inherited, home);
    Resolved {
        path: if fb.is_empty() {
            "/usr/bin:/bin:/usr/sbin:/sbin".to_string()
        } else {
            fb
        },
        vars: Vec::new(),
    }
}

/// Runs `$SHELL -ilc 'printf START"$PATH"END; printf ENVSTART; env -0; printf ENVEND'` (one process) and returns
/// stdout, or None on spawn failure or timeout (the shell is killed). Invalid UTF-8 is replaced, and values that
/// contain a replacement character are not forwarded. If `env -0` is unsupported the second block is just empty. Works for bash, zsh and fish (fish joins path variables with `:` in quotes).
#[cfg(unix)]
pub fn run_login_shell(shell: &str, timeout: Duration) -> Option<String> {
    use std::os::unix::process::CommandExt;
    if !Path::new(shell).is_absolute() {
        return None;
    }
    let script = format!(
        "printf '%s%s%s' '{START}' \"$PATH\" '{END}'; printf '%s' '{ENV_START}'; env -0 2>/dev/null; printf '%s' '{ENV_END}'"
    );
    let mut child = Command::new(shell)
        .args(["-ilc", &script])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        // Own group: an interactive shell may try to grab the terminal and spawn helpers; we kill the lot on timeout.
        .process_group(0)
        .spawn()
        .ok()?;
    let mut stdout = child.stdout.take()?;
    let reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stdout.read_to_end(&mut buf);
        buf
    });
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            _ => {
                let pid = child.id() as i32;
                // SAFETY: plain signal to the group we created.
                unsafe { libc::killpg(pid, libc::SIGKILL) };
                let _ = child.kill();
                let _ = child.wait();
                // The reader ends once every holder of the pipe is dead.
                let _ = reader.join();
                return None;
            }
        }
    }
    Some(String::from_utf8_lossy(&reader.join().ok()?).into_owned())
}

#[cfg(not(unix))]
pub fn run_login_shell(_shell: &str, _timeout: Duration) -> Option<String> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wrap(p: &str) -> String {
        format!("{START}{p}{END}")
    }

    #[test]
    fn parses_a_clean_value() {
        assert_eq!(
            parse_delimited_path(&wrap("/usr/bin:/bin")),
            Some("/usr/bin:/bin".into())
        );
    }

    #[test]
    fn ignores_banners_before_and_after() {
        let out = format!(
            "Last login: Tue\nWelcome to zsh\n{}\nbye\n",
            wrap("/opt/homebrew/bin:/usr/bin")
        );
        assert_eq!(
            parse_delimited_path(&out),
            Some("/opt/homebrew/bin:/usr/bin".into())
        );
    }

    #[test]
    fn last_marker_pair_wins() {
        let out = format!("echo {START}$PATH{END}\n{}", wrap("/a:/b"));
        assert_eq!(parse_delimited_path(&out), Some("/a:/b".into()));
    }

    #[test]
    fn rejects_missing_markers_empty_multiline_and_relative() {
        assert_eq!(parse_delimited_path(""), None);
        assert_eq!(parse_delimited_path("/usr/bin"), None);
        assert_eq!(parse_delimited_path(&format!("{START}/usr/bin")), None);
        assert_eq!(parse_delimited_path(&wrap("")), None);
        assert_eq!(parse_delimited_path(&wrap("/a\n/b")), None);
        assert_eq!(parse_delimited_path(&wrap("$PATH")), None);
        assert_eq!(parse_delimited_path(&wrap("bin:/usr/bin")), None);
    }

    #[test]
    fn tolerates_crlf_and_padding_around_the_value() {
        assert_eq!(
            parse_delimited_path(&format!("{START} /a:/b {END}\r\n")),
            Some("/a:/b".into())
        );
    }

    #[test]
    fn merge_dedupes_and_keeps_order() {
        assert_eq!(merge_paths(&["/a:/b::/a", "/b:/c"]), "/a:/b:/c");
        assert_eq!(merge_paths(&["", ""]), "");
    }

    #[test]
    fn fallback_adds_common_dirs_after_the_inherited_path() {
        let p = fallback_path("/usr/bin:/bin", Some("/Users/me/"));
        let parts: Vec<&str> = p.split(':').collect();
        assert_eq!(&parts[..2], ["/usr/bin", "/bin"]);
        for want in [
            "/opt/homebrew/bin",
            "/usr/local/bin",
            "/Users/me/.local/bin",
            "/Users/me/.cargo/bin",
            "/Users/me/go/bin",
        ] {
            assert!(parts.contains(&want), "missing {want} in {p}");
        }
    }

    #[test]
    fn fallback_without_home_has_no_relative_entries() {
        let p = fallback_path("", None);
        assert!(p.split(':').all(|e| e.starts_with('/')));
        assert!(p.contains("/opt/homebrew/bin"));
    }

    #[test]
    fn resolve_falls_back_for_missing_or_relative_shell() {
        let t = Duration::from_millis(200);
        let p = resolve_path(None, "/usr/bin", Some("/h"), t);
        assert!(p.starts_with("/usr/bin:") && p.contains("/h/.cargo/bin"));
        assert_eq!(
            resolve_path(Some("sh"), "/usr/bin", None, t),
            fallback_path("/usr/bin", None)
        );
        assert_eq!(
            resolve_path(Some("/nonexistent/shell"), "/usr/bin", None, t),
            fallback_path("/usr/bin", None)
        );
    }

    #[cfg(unix)]
    fn script(dir: &Path, body: &str) -> String {
        use std::os::unix::fs::PermissionsExt;
        let p = dir.join("fakeshell");
        std::fs::write(&p, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
        p.to_string_lossy().into_owned()
    }

    #[cfg(unix)]
    fn tmp(name: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("octo-sidecar-{name}-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[cfg(unix)]
    #[test]
    fn real_shell_with_a_banner_is_parsed() {
        let d = tmp("banner");
        // Ignores its arguments, prints a banner, then the marked PATH.
        let sh = script(
            &d,
            &format!("echo 'welcome back'; printf '%s' '{START}/login/bin:/usr/bin{END}'; echo"),
        );
        let p = resolve_path(Some(&sh), "/inherited/bin", None, Duration::from_secs(3));
        assert_eq!(p, "/login/bin:/usr/bin:/inherited/bin");
        let _ = std::fs::remove_dir_all(d);
    }

    #[cfg(unix)]
    #[test]
    fn the_real_sh_prints_its_path() {
        // /bin/sh -ilc must work on every Linux/macOS host; the markers must round-trip.
        let out = run_login_shell("/bin/sh", Duration::from_secs(3)).expect("sh ran");
        assert!(parse_delimited_path(&out).is_some(), "got {out:?}");
    }

    #[cfg(unix)]
    #[test]
    fn a_hanging_shell_is_killed_at_the_timeout() {
        let d = tmp("hang");
        let sh = script(&d, "sleep 30");
        let t0 = Instant::now();
        let p = resolve_path(Some(&sh), "/usr/bin", None, Duration::from_millis(300));
        assert!(t0.elapsed() < Duration::from_secs(5));
        assert_eq!(p, fallback_path("/usr/bin", None));
        let _ = std::fs::remove_dir_all(d);
    }

    #[cfg(unix)]
    #[test]
    fn a_failing_shell_falls_back() {
        let d = tmp("fail");
        let sh = script(&d, "echo 'no markers'; exit 3");
        assert_eq!(
            resolve_path(Some(&sh), "/usr/bin", None, Duration::from_secs(2)),
            fallback_path("/usr/bin", None)
        );
        let _ = std::fs::remove_dir_all(d);
    }

    // ---- environment forwarding (pure parts compile on every platform) ----

    fn pairs(v: &[(&str, &str)]) -> Vec<(String, String)> {
        v.iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    fn env_block(entries: &[&str]) -> String {
        let mut s = String::from(ENV_START);
        for e in entries {
            s.push_str(e);
            s.push('\0');
        }
        s.push_str(ENV_END);
        s
    }

    #[test]
    fn env_block_keeps_newlines_and_equals_in_values() {
        let out = format!(
            "banner\n{}\nbye",
            env_block(&[
                "A=x=y=z",
                "B=line1\nline2\n",
                "C=",
                "novalue",
                "1BAD=x",
                "BAD NAME=x"
            ])
        );
        assert_eq!(
            parse_env_block(&out),
            pairs(&[("A", "x=y=z"), ("B", "line1\nline2\n"), ("C", "")])
        );
    }

    #[test]
    fn env_block_needs_both_markers_and_the_last_pair_wins() {
        assert!(parse_env_block("").is_empty());
        assert!(parse_env_block(&format!("{ENV_START}A=1\0")).is_empty());
        let out = format!("{}{}", env_block(&["A=old"]), env_block(&["A=new"]));
        assert_eq!(parse_env_block(&out), pairs(&[("A", "new")]));
    }

    #[test]
    fn the_allow_list_forwards_what_the_issue_names() {
        for n in [
            "LANG",
            "LC_ALL",
            "LC_CTYPE",
            "XDG_CONFIG_HOME",
            "XDG_DATA_HOME",
            "XDG_STATE_HOME",
            "XDG_CACHE_HOME",
            "SSH_AUTH_SOCK",
            "NVM_DIR",
            "BUN_INSTALL",
            "PNPM_HOME",
            "VOLTA_HOME",
            "HTTP_PROXY",
            "HTTPS_PROXY",
            "NO_PROXY",
            "http_proxy",
            "https_proxy",
            "no_proxy",
            "SSL_CERT_FILE",
            "NODE_EXTRA_CA_CERTS",
            "TMPDIR",
            "SHELL",
            "USER",
            "LOGNAME",
            "TERM",
        ] {
            assert!(forwardable(n), "{n} should be forwarded");
        }
        for n in [
            "HOME",
            "PATH",
            "EDITOR",
            "AWS_PROFILE",
            "lang",
            "LCX",
            "ALL_PROXY",
        ] {
            assert!(!forwardable(n), "{n} should not be forwarded");
        }
    }

    #[test]
    fn nothing_on_the_allow_list_looks_like_a_secret() {
        for n in FORWARD_EXACT {
            assert!(!is_denied(n), "{n} is on the list and matches a deny word");
        }
    }

    #[test]
    fn secret_looking_names_are_never_forwarded_even_if_listed() {
        let vars = pairs(&[
            ("OPENAI_API_KEY", "k"),
            ("GITHUB_TOKEN", "t"),
            ("my_secret", "s"),
            ("DB_PASSWORD", "p"),
            ("DB_PASSWD", "p"),
            ("AWS_SHARED_CREDENTIALS_FILE", "/x"),
            ("LC_API_KEY", "k"),
            ("npm_config_authToken", "t"),
            ("LANG", "en_US.UTF-8"),
        ]);
        // A list that names every one of them, as if someone added them later.
        let got = select_forwarded(&vars, |_| true, &[]);
        assert_eq!(got, pairs(&[("LANG", "en_US.UTF-8")]));
        // And through the real list, including a prefix match.
        let got = select_forwarded(&vars, is_listed, &[]);
        assert_eq!(got, pairs(&[("LANG", "en_US.UTF-8")]));
        for n in ["LC_API_KEY", "XDG_CONFIG_TOKEN", "NO_PROXY_SECRET"] {
            assert!(!forwardable(n), "{n}");
        }
        for n in DENY_WORDS {
            assert!(is_denied(&format!("X_{}_Y", n.to_lowercase())));
        }
    }

    #[test]
    fn select_drops_path_empty_values_user_set_names_and_duplicates() {
        let vars = pairs(&[
            ("PATH", "/x"),
            ("LANG", ""),
            ("TMPDIR", "/t1"),
            ("TMPDIR", "/t2"),
            ("NVM_DIR", "/nvm"),
            ("XDG_DATA_HOME", "bad\u{FFFD}value"),
            ("HTTPS_PROXY", "http://p:3128"),
        ]);
        let got = select_forwarded(&vars, is_listed, &["NVM_DIR".to_string()]);
        assert_eq!(
            got,
            pairs(&[("TMPDIR", "/t1"), ("HTTPS_PROXY", "http://p:3128")])
        );
    }

    #[test]
    fn no_shell_means_the_old_fallback_and_no_variables() {
        let r = resolve(
            None,
            "/usr/bin",
            Some("/h"),
            Duration::from_millis(100),
            &[],
        );
        assert_eq!(r.path, fallback_path("/usr/bin", Some("/h")));
        assert!(r.vars.is_empty());
        assert!(r.names().is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn a_fake_login_shell_yields_path_and_only_allow_listed_variables() {
        let d = tmp("envfwd");
        // A banner, the PATH block, then NUL separated entries with a newline and `=` in values.
        let sh = script(
            &d,
            &format!(
                "echo 'welcome'; printf '%s' '{START}/login/bin{END}'; printf '%s' '{ENV_START}'; \
                 printf 'LANG=en_GB.UTF-8\\0OPENAI_API_KEY=sk-1\\0GITHUB_TOKEN=gh\\0'; \
                 printf 'NODE_EXTRA_CA_CERTS=/ca/a=b.pem\\0HTTPS_PROXY=http://h:1/?a=b\\0'; \
                 printf 'XDG_CONFIG_HOME=/c\\nonfig\\0EDITOR=vim\\0LC_ALL=C\\0PATH=/ignored\\0'; \
                 printf '%s' '{ENV_END}'; echo done"
            ),
        );
        let r = resolve(
            Some(&sh),
            "/inherited/bin",
            None,
            Duration::from_secs(3),
            &[],
        );
        assert_eq!(r.path, "/login/bin:/inherited/bin");
        assert_eq!(
            r.vars,
            pairs(&[
                ("LANG", "en_GB.UTF-8"),
                ("NODE_EXTRA_CA_CERTS", "/ca/a=b.pem"),
                ("HTTPS_PROXY", "http://h:1/?a=b"),
                ("XDG_CONFIG_HOME", "/c\nonfig"),
                ("LC_ALL", "C"),
            ])
        );
        let names = r.names().join(",");
        assert!(!names.contains("KEY") && !names.contains("TOKEN") && !names.contains("EDITOR"));
        let _ = std::fs::remove_dir_all(d);
    }

    #[cfg(unix)]
    #[test]
    fn names_set_in_harness_env_are_not_overridden_by_the_login_shell() {
        let d = tmp("envprec");
        let sh = script(
            &d,
            &format!(
                "printf '%s' '{START}/l{END}{ENV_START}'; printf 'LANG=login\\0TMPDIR=/login/tmp\\0'; printf '%s' '{ENV_END}'"
            ),
        );
        let user_set = vec!["LANG".to_string()];
        let r = resolve(Some(&sh), "", None, Duration::from_secs(3), &user_set);
        assert_eq!(r.vars, pairs(&[("TMPDIR", "/login/tmp")]));
        // Not named in harness.env: the login shell's value is sent (it wins over the app's own).
        let r = resolve(Some(&sh), "", None, Duration::from_secs(3), &[]);
        assert_eq!(
            r.vars,
            pairs(&[("LANG", "login"), ("TMPDIR", "/login/tmp")])
        );
        let _ = std::fs::remove_dir_all(d);
    }

    #[cfg(unix)]
    #[test]
    fn a_shell_without_env_support_still_gives_the_path() {
        let d = tmp("noenv");
        // Only the PATH block, as an older or odd shell setup would print.
        let sh = script(&d, &format!("printf '%s' '{START}/login/bin{END}'"));
        let r = resolve(Some(&sh), "/i", None, Duration::from_secs(3), &[]);
        assert_eq!(r.path, "/login/bin:/i");
        assert!(r.vars.is_empty());
        let _ = std::fs::remove_dir_all(d);
    }

    #[cfg(unix)]
    #[test]
    fn a_hanging_shell_gives_the_fallback_and_no_variables() {
        let d = tmp("hangenv");
        let sh = script(&d, &format!("printf '%s' '{ENV_START}LANG=x\\0'; sleep 30"));
        let t0 = Instant::now();
        let r = resolve(Some(&sh), "/usr/bin", None, Duration::from_millis(300), &[]);
        assert!(t0.elapsed() < Duration::from_secs(5));
        assert_eq!(r.path, fallback_path("/usr/bin", None));
        assert!(r.vars.is_empty());
        let _ = std::fs::remove_dir_all(d);
    }

    #[cfg(unix)]
    #[test]
    fn the_real_sh_prints_a_parseable_environment() {
        let out = run_login_shell("/bin/sh", Duration::from_secs(3)).expect("sh ran");
        let all = parse_env_block(&out);
        // `env -0` is in GNU coreutils and recent BSD/macOS; where it is missing the block is empty and that is
        // tolerated, so only check the shape when there is one.
        if !all.is_empty() {
            assert!(all.iter().any(|(k, _)| k == "PATH"), "got {all:?}");
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_env_dash_zero_is_available() {
        let o = Command::new("/usr/bin/env").arg("-0").output().unwrap();
        assert!(o.status.success() && o.stdout.contains(&0u8));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_env_dash_zero_is_available() {
        let o = Command::new("env").arg("-0").output().unwrap();
        assert!(o.status.success() && o.stdout.contains(&0u8));
    }
}
