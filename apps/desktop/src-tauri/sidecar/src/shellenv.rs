//! Login-shell `PATH` resolution.
//!
//! A GUI app started from Finder does not inherit the user's shell `PATH`, but the agents the harness drives
//! (`npx`, `claude`, `copilot`, ...) live in directories only the shell profile adds. So we ask the user's own
//! shell, interactively and as a login shell, to print it between markers (profiles print banners, so the output
//! cannot be taken as is), with a short timeout (a hanging profile must not block start-up).

use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

pub const START: &str = "__OCTO_PATH_START__";
pub const END: &str = "__OCTO_PATH_END__";
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
    if let Some(shell) = shell.filter(|s| !s.is_empty()) {
        if let Some(login) =
            run_login_shell(shell, timeout).and_then(|out| parse_delimited_path(&out))
        {
            return merge_paths(&[&login, inherited]);
        }
    }
    let fb = fallback_path(inherited, home);
    if fb.is_empty() {
        "/usr/bin:/bin:/usr/sbin:/sbin".to_string()
    } else {
        fb
    }
}

/// Runs `$SHELL -ilc 'printf START"$PATH"END'` and returns stdout, or None on spawn failure, timeout (the shell
/// is killed) or a non-UTF-8 result. Works for bash, zsh and fish (fish joins path variables with `:` in quotes).
#[cfg(unix)]
pub fn run_login_shell(shell: &str, timeout: Duration) -> Option<String> {
    use std::os::unix::process::CommandExt;
    if !Path::new(shell).is_absolute() {
        return None;
    }
    let script = format!("printf '%s%s%s' '{START}' \"$PATH\" '{END}'");
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
    String::from_utf8(reader.join().ok()?).ok()
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
}
