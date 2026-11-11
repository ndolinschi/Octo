//! Ties the pieces together: override, settings, the optional router, free ports, PATH, spawn, health, stop.
//!
//! Start order (design P8): read `harness.env`; when the router is switched on and has an upstream key, start the
//! router on a free loopback port with a generated client key and wait for its `/health`; then start the harness,
//! pointed at `http://127.0.0.1:<port>/autoroute`. A router that fails does not block the app: the harness starts
//! alone and the failure is kept as a notice ([`Bridge::notices`]). Stop order: harness first, then router.

use crate::health::{self, WaitError};
use crate::logfile::{tail_lines, CappedLog, SharedLog, DEFAULT_MAX_BYTES};
use crate::process::{self, Sidecar, SpawnSpec, STOP_GRACE};
use crate::settings::RouterSettings;
use crate::{port, router, shellenv};
use serde::Serialize;
use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub const LOG_NAME: &str = "harness.log";
pub use crate::router::LOG_NAME as ROUTER_LOG_NAME;

/// How many log lines a notice carries.
const NOTICE_LOG_LINES: usize = 30;
/// The router opens SQLite and applies migrations before it listens.
const ROUTER_HEALTH_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Clone, Debug)]
pub struct BridgeConfig {
    /// The sidecar executable.
    pub harness_bin: PathBuf,
    /// `harness serve --data-dir`; `harness.env` lives here.
    pub data_dir: PathBuf,
    /// Where `harness.log` and `router.log` (and their `.1` rotations) go.
    pub log_dir: PathBuf,
    /// `OCTO_BRIDGE_URL`: when set and non-empty, nothing is started.
    pub override_url: Option<String>,
    /// The bundled router executable; None when the app was built without one.
    pub router_bin: Option<PathBuf>,
    /// The router's data: `config/` fragments, `history.sqlite`, `router.pid` (default: `{data_dir}/../router`).
    pub router_dir: PathBuf,
    /// The settings file the shell reads (default: `{data_dir}/harness.env`).
    pub settings_path: PathBuf,
    pub health_timeout: Duration,
    pub router_health_timeout: Duration,
    pub log_max_bytes: u64,
}

impl BridgeConfig {
    pub fn new(
        harness_bin: PathBuf,
        data_dir: PathBuf,
        log_dir: PathBuf,
        override_url: Option<String>,
    ) -> Self {
        let router_dir = data_dir
            .parent()
            .map(|p| p.join("router"))
            .unwrap_or_else(|| data_dir.join("router"));
        let settings_path = data_dir.join("harness.env");
        Self {
            harness_bin,
            data_dir,
            log_dir,
            override_url,
            router_bin: None,
            router_dir,
            settings_path,
            health_timeout: health::DEFAULT_TIMEOUT,
            router_health_timeout: ROUTER_HEALTH_TIMEOUT,
            log_max_bytes: DEFAULT_MAX_BYTES,
        }
    }

    /// Sets the bundled router executable.
    pub fn with_router(mut self, router_bin: PathBuf) -> Self {
        self.router_bin = Some(router_bin);
        self
    }
}

/// Something the UI should tell the person without blocking them.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Notice {
    /// `router_failed`.
    pub kind: String,
    pub message: String,
    pub log_tail: String,
}

/// A started (or overridden) bridge. Fields drop in order: harness first, then router.
pub struct Running {
    pub url: String,
    harness: Option<Sidecar>,
    router: Option<Sidecar>,
}

/// Normalises `OCTO_BRIDGE_URL`: trimmed, no trailing slash, must be http(s); None when unset or blank.
pub fn parse_override(value: Option<&str>) -> Result<Option<String>, String> {
    let Some(v) = value.map(str::trim).filter(|v| !v.is_empty()) else {
        return Ok(None);
    };
    if !(v.starts_with("http://") || v.starts_with("https://")) {
        return Err(format!(
            "OCTO_BRIDGE_URL must start with http:// or https:// (got \"{v}\")"
        ));
    }
    Ok(Some(v.trim_end_matches('/').to_string()))
}

/// The arguments of `harness serve` for this port and data dir.
pub fn serve_args(port: u16, data_dir: &std::path::Path) -> Vec<String> {
    vec![
        "serve".into(),
        "--addr".into(),
        format!("127.0.0.1:{port}"),
        "--data-dir".into(),
        data_dir.to_string_lossy().into_owned(),
    ]
}

/// [`serve_args`] plus `--base-url` when the harness should talk to a router. (The router client key is not an
/// argument: it goes in the environment as `HARNESS_OCTO_KEY` so it never shows in a process listing.)
pub fn harness_args(port: u16, data_dir: &std::path::Path, base_url: Option<&str>) -> Vec<String> {
    let mut args = serve_args(port, data_dir);
    if let Some(u) = base_url {
        args.push("--base-url".into());
        args.push(u.into());
    }
    args
}

/// Owns at most one running harness (and router). All methods block; call them from a blocking thread.
pub struct Bridge {
    cfg: BridgeConfig,
    running: Mutex<Option<Running>>,
    /// Why the router did not start in the current run.
    router_failure: Mutex<Option<String>>,
}

impl Bridge {
    pub fn new(cfg: BridgeConfig) -> Self {
        Self {
            cfg,
            running: Mutex::new(None),
            router_failure: Mutex::new(None),
        }
    }

    pub fn log_path(&self) -> PathBuf {
        self.cfg.log_dir.join(LOG_NAME)
    }

    pub fn router_log_path(&self) -> PathBuf {
        self.cfg.log_dir.join(ROUTER_LOG_NAME)
    }

    pub fn log_tail(&self, lines: usize) -> String {
        tail_lines(&self.log_path(), lines)
    }

    /// Notices for the current run: empty when all is well, one `router_failed` when the router was wanted but did
    /// not come up (the harness runs without it).
    pub fn notices(&self) -> Vec<Notice> {
        let failure = self.router_failure.lock().ok().and_then(|g| g.clone());
        match failure {
            Some(message) => vec![Notice {
                kind: "router_failed".into(),
                message,
                log_tail: tail_lines(&self.router_log_path(), NOTICE_LOG_LINES),
            }],
            None => Vec::new(),
        }
    }

    /// The bridge URL, starting the harness on first use. Concurrent callers serialise; later ones get the same URL.
    /// A harness that has died since is restarted.
    pub fn url(&self) -> Result<String, String> {
        let mut guard = self
            .running
            .lock()
            .map_err(|_| "internal error: bridge state is poisoned".to_string())?;
        if let Some(r) = guard.as_mut() {
            let alive = r
                .harness
                .as_mut()
                .map(|s| s.exited().is_none())
                .unwrap_or(true);
            if alive {
                return Ok(r.url.clone());
            }
            *guard = None; // dropped: reaps and sweeps the groups
            self.remove_pid_files();
        }
        let running = self.start()?;
        let url = running.url.clone();
        *guard = Some(running);
        Ok(url)
    }

    /// Stops the harness and the router (if any) and starts them again with the current settings file.
    pub fn restart(&self) -> Result<String, String> {
        self.stop();
        self.url()
    }

    /// Harness first (SIGTERM, 3 s, SIGKILL on its group), then the router. No-op when nothing runs.
    pub fn stop(&self) {
        let taken = self.running.lock().ok().and_then(|mut g| g.take());
        if let Some(mut r) = taken {
            if let Some(sc) = r.harness.as_mut() {
                sc.stop(STOP_GRACE);
            }
            if let Some(sc) = r.router.as_mut() {
                sc.stop(STOP_GRACE);
            }
            self.remove_pid_files();
        }
    }

    fn remove_pid_files(&self) {
        let _ = std::fs::remove_file(self.cfg.data_dir.join("harness.pid"));
        let _ = std::fs::remove_file(self.cfg.router_dir.join(router::PID_NAME));
    }

    fn set_router_failure(&self, message: Option<String>) {
        if let Ok(mut g) = self.router_failure.lock() {
            *g = message;
        }
    }

    /// Starts the router for `settings`: Ok((process, port, client key)) once its `/health` answers.
    fn start_router(&self) -> Result<(Sidecar, u16, String), String> {
        let cfg = &self.cfg;
        let bin = cfg
            .router_bin
            .as_ref()
            .filter(|p| p.is_file())
            .ok_or_else(|| match &cfg.router_bin {
                Some(p) => format!(
                    "The bundled router is missing at {}. Rebuild the app (scripts/install.sh builds it) or switch the router off.",
                    p.display()
                ),
                None => "This build of Octo has no bundled router. Rebuild the app (scripts/install.sh builds it) or switch the router off.".to_string(),
            })?;
        std::fs::create_dir_all(&cfg.router_dir).map_err(|e| {
            format!(
                "cannot create the router data directory {}: {e}",
                cfg.router_dir.display()
            )
        })?;
        let pidfile = cfg.router_dir.join(router::PID_NAME);
        let reaped_stale = process::kill_stale_named(&pidfile, router::PROCESS_NAMES);
        let log = CappedLog::open(&cfg.log_dir, ROUTER_LOG_NAME, cfg.log_max_bytes)
            .map_err(|e| format!("cannot open the log in {}: {e}", cfg.log_dir.display()))?;
        let log: SharedLog = Arc::new(Mutex::new(log));
        let port = port::pick_free_port().map_err(|e| format!("cannot pick a free port: {e}"))?;
        let key = router::generate_key();
        let config_dir = router::write_config(&cfg.router_dir, port, &key)
            .map_err(|e| format!("cannot write the router configuration: {e}"))?;
        if let Ok(mut l) = log.lock() {
            let _ = l.line(&format!(
                "--- octo: starting {} on 127.0.0.1:{port} (config {})",
                bin.display(),
                config_dir.display()
            ));
            if reaped_stale {
                let _ = l.line("--- octo: terminated a router left over from an earlier run");
            }
        }
        let mut sidecar = Sidecar::spawn(SpawnSpec {
            program: bin,
            args: Vec::new(),
            env: vec![(
                "OCTO_CONFIG".into(),
                config_dir.to_string_lossy().into_owned(),
            )],
            log,
        })
        .map_err(|e| format!("cannot start {}: {e}", bin.display()))?;
        let _ = process::write_pidfile(&pidfile, sidecar.pid());
        let addr = SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::LOCALHOST, port));
        match health::wait_healthy(addr, cfg.router_health_timeout, || sidecar.exited()) {
            Ok(()) => Ok((sidecar, port, key)),
            Err(e) => {
                sidecar.stop(STOP_GRACE);
                let _ = std::fs::remove_file(&pidfile);
                Err(match e {
                    WaitError::Timeout => format!(
                        "The router did not answer /health within {} s.",
                        cfg.router_health_timeout.as_secs()
                    ),
                    WaitError::Gone(why) => format!("The router stopped during start-up: {why}."),
                })
            }
        }
    }

    fn start(&self) -> Result<Running, String> {
        if let Some(url) = parse_override(self.cfg.override_url.as_deref())? {
            self.set_router_failure(None);
            return Ok(Running {
                url,
                harness: None,
                router: None,
            });
        }
        let cfg = &self.cfg;
        if !cfg.harness_bin.is_file() {
            return Err(format!(
                "The bundled harness is missing at {}. Rebuild the app (scripts/install.sh builds it) or set OCTO_HARNESS_BIN.",
                cfg.harness_bin.display()
            ));
        }
        std::fs::create_dir_all(&cfg.data_dir).map_err(|e| {
            format!(
                "cannot create the data directory {}: {e}",
                cfg.data_dir.display()
            )
        })?;

        // 1. The router, when wanted. Its failure is a notice, never an error.
        let settings = RouterSettings::load(&cfg.settings_path);
        self.set_router_failure(None);
        let mut router_sc: Option<Sidecar> = None;
        let mut base_url: Option<String> = None;
        let mut env: Vec<(String, String)> = Vec::new();
        if let Some(external) = settings.base_url.clone() {
            base_url = Some(external); // an external router: nothing of ours is started
        } else if let (true, Some(upstream)) = (settings.enabled, settings.upstream_key.clone()) {
            match self.start_router() {
                Ok((sc, port, client_key)) => {
                    router_sc = Some(sc);
                    base_url = Some(format!("http://127.0.0.1:{port}/autoroute"));
                    // The router forwards the caller's credential upstream; the client key is its own gate.
                    env.push(("HARNESS_OCTO_KEY".into(), client_key));
                    env.push(("ANTHROPIC_API_KEY".into(), upstream));
                }
                Err(message) => self.set_router_failure(Some(message)),
            }
        }

        // 2. The harness.
        let pidfile = cfg.data_dir.join("harness.pid");
        let reaped_stale = process::kill_stale(&pidfile);
        let log = CappedLog::open(&cfg.log_dir, LOG_NAME, cfg.log_max_bytes)
            .map_err(|e| format!("cannot open the log in {}: {e}", cfg.log_dir.display()))?;
        let log: SharedLog = Arc::new(Mutex::new(log));

        let port = port::pick_free_port().map_err(|e| format!("cannot pick a free port: {e}"))?;
        let inherited = std::env::var("PATH").unwrap_or_default();
        let home = std::env::var("HOME").ok();
        let shell = std::env::var("SHELL").ok();
        let path = shellenv::resolve_path(
            shell.as_deref(),
            &inherited,
            home.as_deref(),
            shellenv::DEFAULT_TIMEOUT,
        );
        let args = harness_args(port, &cfg.data_dir, base_url.as_deref());
        if let Ok(mut l) = log.lock() {
            let _ = l.line(&format!(
                "--- octo: starting {} {}",
                cfg.harness_bin.display(),
                args.join(" ")
            ));
            let _ = l.line(&format!("--- octo: PATH={path}"));
            if reaped_stale {
                let _ = l.line("--- octo: terminated a harness left over from an earlier run");
            }
        }
        env.push(("PATH".into(), path));

        // On any failure below, `router_sc` is dropped, which stops the router.
        let mut sidecar = Sidecar::spawn(SpawnSpec {
            program: &cfg.harness_bin,
            args,
            env,
            log,
        })
        .map_err(|e| format!("cannot start {}: {e}", cfg.harness_bin.display()))?;
        let _ = process::write_pidfile(&pidfile, sidecar.pid());

        let addr = SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::LOCALHOST, port));
        match health::wait_healthy(addr, cfg.health_timeout, || sidecar.exited()) {
            Ok(()) => Ok(Running {
                url: format!("http://127.0.0.1:{port}"),
                harness: Some(sidecar),
                router: router_sc,
            }),
            Err(e) => {
                sidecar.stop(STOP_GRACE);
                drop(router_sc);
                self.remove_pid_files();
                Err(match e {
                    WaitError::Timeout => format!(
                        "The harness did not answer /health within {} s.",
                        cfg.health_timeout.as_secs()
                    ),
                    WaitError::Gone(why) => format!("The harness stopped during start-up: {why}."),
                })
            }
        }
    }
}

impl Drop for Bridge {
    fn drop(&mut self) {
        self.stop();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn override_parsing() {
        assert_eq!(parse_override(None), Ok(None));
        assert_eq!(parse_override(Some("  ")), Ok(None));
        assert_eq!(
            parse_override(Some(" http://127.0.0.1:8790/ ")),
            Ok(Some("http://127.0.0.1:8790".into()))
        );
        assert_eq!(
            parse_override(Some("https://h.example")),
            Ok(Some("https://h.example".into()))
        );
        assert!(parse_override(Some("127.0.0.1:8790")).is_err());
    }

    #[test]
    fn serve_arguments() {
        assert_eq!(
            serve_args(4242, std::path::Path::new("/d/harness")),
            [
                "serve",
                "--addr",
                "127.0.0.1:4242",
                "--data-dir",
                "/d/harness"
            ]
        );
    }

    #[test]
    fn override_starts_nothing() {
        let cfg = BridgeConfig::new(
            "/nonexistent".into(),
            "/nonexistent/d".into(),
            "/nonexistent/l".into(),
            Some("http://127.0.0.1:9/".into()),
        );
        let b = Bridge::new(cfg);
        assert_eq!(b.url().unwrap(), "http://127.0.0.1:9");
        assert_eq!(b.url().unwrap(), "http://127.0.0.1:9");
        b.stop();
    }

    #[test]
    fn a_bad_override_is_an_error_not_a_fallback() {
        let cfg = BridgeConfig::new(
            "/nonexistent".into(),
            "/x".into(),
            "/y".into(),
            Some("nope".into()),
        );
        assert!(Bridge::new(cfg)
            .url()
            .unwrap_err()
            .contains("OCTO_BRIDGE_URL"));
    }

    #[test]
    fn a_missing_binary_names_the_path() {
        let cfg = BridgeConfig::new(
            "/nonexistent/harness".into(),
            "/x".into(),
            "/y".into(),
            None,
        );
        let e = Bridge::new(cfg).url().unwrap_err();
        assert!(e.contains("/nonexistent/harness"), "{e}");
    }

    #[cfg(unix)]
    mod unix {
        use super::*;
        use std::os::unix::fs::PermissionsExt;

        fn tmp(name: &str) -> PathBuf {
            let d = std::env::temp_dir().join(format!("octo-bridge-{name}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&d);
            std::fs::create_dir_all(&d).unwrap();
            d
        }

        fn fake_harness(dir: &std::path::Path, body: &str) -> PathBuf {
            let p = dir.join("harness");
            std::fs::write(&p, format!("#!/bin/sh\n{body}\n")).unwrap();
            std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
            p
        }

        #[test]
        fn a_harness_that_exits_early_fails_fast_with_its_output_in_the_log() {
            let d = tmp("early");
            let bin = fake_harness(&d, "echo 'boom: cannot open db' >&2; exit 2");
            let mut cfg = BridgeConfig::new(bin, d.join("data"), d.join("logs"), None);
            cfg.health_timeout = Duration::from_secs(10);
            let b = Bridge::new(cfg);
            let t0 = std::time::Instant::now();
            let e = b.url().unwrap_err();
            assert!(
                t0.elapsed() < Duration::from_secs(8),
                "should not wait out the timeout"
            );
            assert!(e.contains("stopped during start-up"), "{e}");
            assert!(
                b.log_tail(20).contains("boom: cannot open db"),
                "{}",
                b.log_tail(20)
            );
            assert!(!d.join("data/harness.pid").exists());
            let _ = std::fs::remove_dir_all(d);
        }

        #[test]
        fn a_harness_that_never_answers_times_out_and_is_stopped() {
            let d = tmp("hang");
            let bin = fake_harness(&d, "sleep 60");
            let mut cfg = BridgeConfig::new(bin, d.join("data"), d.join("logs"), None);
            cfg.health_timeout = Duration::from_millis(500);
            let b = Bridge::new(cfg);
            let e = b.url().unwrap_err();
            assert!(e.contains("did not answer /health"), "{e}");
            let _ = std::fs::remove_dir_all(d);
        }

        /// A tiny stand-in that answers /health on the port it is given, with python3 or nc missing we skip.
        #[test]
        fn a_healthy_harness_is_started_reused_and_stopped() {
            if std::process::Command::new("python3")
                .arg("--version")
                .output()
                .is_err()
            {
                eprintln!("python3 missing: skipping");
                return;
            }
            let d = tmp("ok");
            // Parses `--addr HOST:PORT` from its arguments like the real one.
            let bin = fake_harness(
                &d,
                r#"while [ $# -gt 0 ]; do [ "$1" = "--addr" ] && addr="$2"; shift; done
exec python3 -c '
import http.server, sys
host, port = sys.argv[1].split(":")
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200); self.send_header("Content-Length","2"); self.end_headers(); self.wfile.write(b"ok")
    def log_message(self, *a): pass
http.server.HTTPServer((host, int(port)), H).serve_forever()
' "$addr""#,
            );
            let b = Bridge::new(BridgeConfig::new(bin, d.join("data"), d.join("logs"), None));
            let url = b.url().unwrap();
            assert!(url.starts_with("http://127.0.0.1:"));
            assert_eq!(b.url().unwrap(), url, "second call reuses the process");
            let pid: u32 = std::fs::read_to_string(d.join("data/harness.pid"))
                .unwrap()
                .trim()
                .parse()
                .unwrap();
            assert!(process::group_alive(pid as i32));
            b.stop();
            std::thread::sleep(Duration::from_millis(50));
            let ps = std::process::Command::new("ps")
                .args(["-A", "-o", "pgid=,stat="])
                .output()
                .unwrap();
            let live = String::from_utf8_lossy(&ps.stdout).lines().any(|l| {
                let mut it = l.split_whitespace();
                it.next().and_then(|p| p.parse::<u32>().ok()) == Some(pid)
                    && !it.next().unwrap_or("Z").starts_with('Z')
            });
            assert!(!live, "no running process left after stop");
            let url2 = b.url().unwrap(); // starts again after a stop
            assert!(url2.starts_with("http://127.0.0.1:"));
            drop(b); // Drop stops it too
            let _ = std::fs::remove_dir_all(d);
        }
    }
}
