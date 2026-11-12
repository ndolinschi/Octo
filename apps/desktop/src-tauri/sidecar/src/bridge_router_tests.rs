//! The two-sidecar sequence against fake binaries: a wrapper script runs `fake.py`, which records its arguments and
//! environment, serves `/health` on the port it was given (`--addr` for the harness, `bind_addr` in
//! `$OCTO_CONFIG/server.toml` for the router) and notes its name in `order.txt` when it receives SIGTERM.
//! No real harness, router or agent CLI is involved. Skipped when `python3` is missing.

use crate::bridge::{Bridge, BridgeConfig};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::time::Duration;

const FAKE_PY: &str = r#"
import http.server, json, os, re, signal, sys, time
role, mode, outdir = sys.argv[1], sys.argv[2], sys.argv[3]
args = sys.argv[4:]
rec = {"role": role, "args": args, "env": {k: os.environ.get(k) for k in ("HARNESS_OCTO_KEY", "HARNESS_API_TOKEN", "ANTHROPIC_API_KEY", "OCTO_CONFIG", "HARNESS_EXIT_ON_STDIN_CLOSE", "OCTO_EXIT_ON_STDIN_CLOSE")}}
cfg = os.environ.get("OCTO_CONFIG")
if cfg:
    for name in ("server.toml", "history.toml", "limits.toml"):
        rec[name] = open(os.path.join(cfg, name)).read()
with open(os.path.join(outdir, role + ".json"), "w") as f:
    json.dump(rec, f)
if mode == "die":
    print("boom: " + role + " cannot start", file=sys.stderr, flush=True)
    sys.exit(3)
if mode == "hang":
    time.sleep(300)
if role == "harness":
    addr = args[args.index("--addr") + 1]
else:
    addr = re.search(r'bind_addr = "([^"]+)"', rec["server.toml"]).group(1)
host, port = addr.split(":")
def term(*_):
    with open(os.path.join(outdir, "order.txt"), "a") as f:
        f.write(role + "\n")
    os._exit(0)
signal.signal(signal.SIGTERM, term)
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200); self.send_header("Content-Length", "2"); self.end_headers(); self.wfile.write(b"ok")
    def log_message(self, *a): pass
http.server.HTTPServer((host, int(port)), H).serve_forever()
"#;

fn have_python() -> bool {
    std::process::Command::new("python3")
        .arg("--version")
        .output()
        .is_ok()
}

struct Env {
    dir: PathBuf,
}

impl Env {
    fn new(name: &str) -> Self {
        let dir = std::env::temp_dir().join(format!("octo-two-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("data")).unwrap();
        std::fs::create_dir_all(dir.join("out")).unwrap();
        std::fs::write(dir.join("fake.py"), FAKE_PY).unwrap();
        Self { dir }
    }

    /// An executable wrapper for `role` ("harness" | "router") in `mode` ("ok" | "die" | "hang").
    fn fake(&self, role: &str, mode: &str) -> PathBuf {
        let p = self.dir.join(format!("fake-{role}"));
        std::fs::write(
            &p,
            format!(
                "#!/bin/sh\nexec python3 {} {role} {mode} {} \"$@\"\n",
                self.dir.join("fake.py").display(),
                self.dir.join("out").display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
        p
    }

    fn bridge(&self, router_mode: Option<&str>) -> Bridge {
        let mut cfg = BridgeConfig::new(
            self.fake("harness", "ok"),
            self.dir.join("data"),
            self.dir.join("logs"),
            None,
        );
        if let Some(m) = router_mode {
            cfg = cfg.with_router(self.fake("router", m));
        }
        cfg.health_timeout = Duration::from_secs(10);
        cfg.router_health_timeout = Duration::from_millis(1500);
        Bridge::new(cfg)
    }

    fn settings(&self, text: &str) {
        std::fs::write(self.dir.join("data/harness.env"), text).unwrap();
    }

    fn record(&self, role: &str) -> Option<serde_json::Value> {
        let text =
            std::fs::read_to_string(self.dir.join("out").join(format!("{role}.json"))).ok()?;
        serde_json::from_str(&text).ok()
    }

    fn forget(&self, role: &str) {
        let _ = std::fs::remove_file(self.dir.join("out").join(format!("{role}.json")));
    }

    fn order(&self) -> Vec<String> {
        std::fs::read_to_string(self.dir.join("out/order.txt"))
            .unwrap_or_default()
            .lines()
            .map(str::to_string)
            .collect()
    }

    fn router_dir(&self) -> PathBuf {
        self.dir.join("router")
    }
}

impl Drop for Env {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn args_of(rec: &serde_json::Value) -> Vec<String> {
    rec["args"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap().to_string())
        .collect()
}

fn toml_value(text: &str, key: &str) -> String {
    let line = text
        .lines()
        .find(|l| l.trim_start().starts_with(key))
        .unwrap_or_else(|| panic!("no {key} in {text}"));
    line.split_once('=')
        .unwrap()
        .1
        .trim()
        .trim_matches('"')
        .to_string()
}

fn port_of_router(rec: &serde_json::Value) -> u16 {
    toml_value(rec["server.toml"].as_str().unwrap(), "bind_addr")
        .rsplit(':')
        .next()
        .unwrap()
        .parse()
        .unwrap()
}

macro_rules! need_python {
    () => {
        if !have_python() {
            eprintln!("python3 missing: skipping");
            return;
        }
    };
}

const ON: &str = "OCTO_ROUTER_ENABLED=1\nOCTO_ROUTER_UPSTREAM_KEY=sk-upstream-test\n";

#[test]
fn router_off_starts_the_harness_alone() {
    need_python!();
    let e = Env::new("off");
    let b = e.bridge(Some("ok"));
    let url = b.url().unwrap();
    assert!(url.starts_with("http://127.0.0.1:"));
    let h = e.record("harness").expect("harness ran");
    assert!(!args_of(&h).iter().any(|a| a == "--base-url"), "{h}");
    assert!(h["env"]["HARNESS_OCTO_KEY"].is_null());
    assert!(h["env"]["OCTO_CONFIG"].is_null());
    assert!(e.record("router").is_none(), "no router must be started");
    assert!(b.notices().is_empty());
    assert!(!e.router_dir().exists());
    b.stop();
}

#[test]
fn the_harness_gets_a_fresh_api_token_in_its_environment_only() {
    need_python!();
    let e = Env::new("token");
    let b = e.bridge(None);
    let first = b.connection().unwrap();
    let h = e.record("harness").expect("harness ran");
    let in_env = h["env"]["HARNESS_API_TOKEN"].as_str().unwrap().to_string();
    assert_eq!(
        in_env, first.token,
        "the webview gets the token the harness has"
    );
    assert_eq!(in_env.len(), 64);
    assert!(in_env.chars().all(|c| c.is_ascii_hexdigit()));
    assert!(first.url.starts_with("http://127.0.0.1:"));
    // Not an argument, not in the log the app keeps.
    assert!(!args_of(&h).iter().any(|a| a.contains(&in_env)), "{h}");
    assert!(!b.log_tail(500).contains(&in_env), "{}", b.log_tail(500));
    // Same run, same token; a restart is a new run with a new token.
    assert_eq!(b.connection().unwrap(), first);
    assert_eq!(b.url().unwrap(), first.url);
    e.forget("harness");
    let second = b.restart_connection().unwrap();
    assert_ne!(second.token, first.token);
    assert_eq!(
        e.record("harness").unwrap()["env"]["HARNESS_API_TOKEN"],
        second.token
    );
    b.stop();
}

#[test]
fn the_router_never_sees_the_api_token() {
    need_python!();
    let e = Env::new("tokenrouter");
    e.settings(ON);
    let b = e.bridge(Some("ok"));
    let conn = b.connection().unwrap();
    let r = e.record("router").expect("router ran");
    assert!(r["env"]["HARNESS_API_TOKEN"].is_null(), "{r}");
    assert!(!r.to_string().contains(&conn.token));
    b.stop();
}

#[test]
fn both_sidecars_are_told_to_exit_when_their_stdin_closes() {
    need_python!();
    let e = Env::new("eofenv");
    e.settings(ON);
    let b = e.bridge(Some("ok"));
    b.url().unwrap();
    for role in ["harness", "router"] {
        let rec = e.record(role).unwrap_or_else(|| panic!("{role} ran"));
        assert_eq!(rec["env"]["HARNESS_EXIT_ON_STDIN_CLOSE"], "1", "{role}");
        assert_eq!(rec["env"]["OCTO_EXIT_ON_STDIN_CLOSE"], "1", "{role}");
        // Environment form only: an older binary that rejects unknown flags must still start.
        assert!(!args_of(&rec).iter().any(|a| a.contains("stdin")), "{rec}");
    }
    b.stop();
}

#[test]
fn enabled_without_a_key_is_the_same_as_off() {
    need_python!();
    let e = Env::new("nokey");
    e.settings("OCTO_ROUTER_ENABLED=1\n");
    let b = e.bridge(Some("ok"));
    b.url().unwrap();
    assert!(e.record("router").is_none());
    assert!(!args_of(&e.record("harness").unwrap()).contains(&"--base-url".to_string()));
    assert!(b.notices().is_empty());
    b.stop();
}

#[test]
fn router_on_and_healthy_hands_the_harness_its_url_and_key() {
    need_python!();
    let e = Env::new("on");
    e.settings(ON);
    let b = e.bridge(Some("ok"));
    b.url().unwrap();
    let r = e.record("router").expect("router ran");
    let h = e.record("harness").expect("harness ran");

    // The router: configured only through OCTO_CONFIG under its own data dir, loopback, with a generated key.
    let cfg_dir = r["env"]["OCTO_CONFIG"].as_str().unwrap();
    assert_eq!(Path::new(cfg_dir), e.router_dir().join("config"));
    assert!(args_of(&r).is_empty());
    let server = r["server.toml"].as_str().unwrap();
    assert!(toml_value(server, "bind_addr").starts_with("127.0.0.1:"));
    assert_eq!(toml_value(server, "allow_remote"), "false");
    let client_key = toml_value(server, "client_auth_key");
    assert_eq!(client_key.len(), 64);
    assert!(
        toml_value(r["history.toml"].as_str().unwrap(), "database_path")
            .starts_with(e.router_dir().to_str().unwrap())
    );
    assert!(r["limits.toml"]
        .as_str()
        .unwrap()
        .contains("max_body_bytes"));

    // The harness: --base-url <router>/autoroute, the client key and the upstream key in its environment only.
    let port = port_of_router(&r);
    let args = args_of(&h);
    let at = args
        .iter()
        .position(|a| a == "--base-url")
        .expect("--base-url");
    assert_eq!(args[at + 1], format!("http://127.0.0.1:{port}/autoroute"));
    assert_eq!(h["env"]["HARNESS_OCTO_KEY"].as_str().unwrap(), client_key);
    assert_eq!(
        h["env"]["ANTHROPIC_API_KEY"].as_str().unwrap(),
        "sk-upstream-test"
    );
    assert!(
        !args
            .iter()
            .any(|a| a.contains(&client_key) || a.contains("sk-upstream")),
        "secrets must not be on the command line: {args:?}"
    );
    assert!(b.notices().is_empty());

    // The harness log never carries the keys; the router log has its own file.
    assert!(!b.log_tail(50).contains(&client_key));
    assert!(b.router_log_path().is_file());
    assert!(e.router_dir().join("router.pid").is_file());
    assert!(e.dir.join("data/harness.pid").is_file());
    b.stop();
    assert!(!e.router_dir().join("router.pid").exists());
    assert!(!e.dir.join("data/harness.pid").exists());
}

#[test]
fn a_new_client_key_and_port_every_launch() {
    need_python!();
    let e = Env::new("keys");
    e.settings(ON);
    let b = e.bridge(Some("ok"));
    b.url().unwrap();
    let first = toml_value(
        e.record("router").unwrap()["server.toml"].as_str().unwrap(),
        "client_auth_key",
    );
    b.restart().unwrap();
    let second = toml_value(
        e.record("router").unwrap()["server.toml"].as_str().unwrap(),
        "client_auth_key",
    );
    assert_ne!(first, second);
    b.stop();
}

#[test]
fn a_router_that_dies_at_start_leaves_the_harness_running_and_a_notice() {
    need_python!();
    let e = Env::new("die");
    e.settings(ON);
    let b = e.bridge(Some("die"));
    let t0 = std::time::Instant::now();
    b.url().expect("the harness must start without the router");
    assert!(t0.elapsed() < Duration::from_secs(8));
    let h = e.record("harness").unwrap();
    assert!(!args_of(&h).contains(&"--base-url".to_string()));
    assert!(h["env"]["HARNESS_OCTO_KEY"].is_null());
    assert!(h["env"]["ANTHROPIC_API_KEY"].is_null());
    let n = b.notices();
    assert_eq!(n.len(), 1, "{n:?}");
    assert_eq!(n[0].kind, "router_failed");
    assert!(
        n[0].message.contains("The router stopped during start-up"),
        "{}",
        n[0].message
    );
    assert!(
        n[0].log_tail.contains("boom: router cannot start"),
        "{}",
        n[0].log_tail
    );
    assert!(!e.router_dir().join("router.pid").exists());
    b.stop();
}

#[test]
fn a_router_that_never_becomes_healthy_is_stopped_and_reported() {
    need_python!();
    let e = Env::new("hang");
    e.settings(ON);
    let b = e.bridge(Some("hang"));
    b.url().expect("the harness must start without the router");
    assert!(!args_of(&e.record("harness").unwrap()).contains(&"--base-url".to_string()));
    let n = b.notices();
    assert_eq!(n.len(), 1);
    assert!(
        n[0].message.contains("did not answer /health"),
        "{}",
        n[0].message
    );
    assert!(
        n[0].log_tail.contains("--- octo: starting"),
        "{}",
        n[0].log_tail
    );
    b.stop();
}

#[test]
fn a_missing_router_binary_is_a_notice_naming_the_path() {
    need_python!();
    let e = Env::new("missing");
    e.settings(ON);
    let mut cfg = BridgeConfig::new(
        e.fake("harness", "ok"),
        e.dir.join("data"),
        e.dir.join("logs"),
        None,
    )
    .with_router("/nonexistent/octo".into());
    cfg.health_timeout = Duration::from_secs(10);
    let b = Bridge::new(cfg);
    b.url().unwrap();
    let n = b.notices();
    assert_eq!(n.len(), 1);
    assert!(
        n[0].message.contains("/nonexistent/octo"),
        "{}",
        n[0].message
    );
    b.stop();
    // And without any router configured at all (a build with --no-router).
    let b = e.bridge(None);
    b.url().unwrap();
    assert!(b.notices()[0].message.contains("no bundled router"));
    b.stop();
}

#[test]
fn an_external_router_url_starts_no_router_and_is_passed_through() {
    need_python!();
    let e = Env::new("ext");
    e.settings(&format!(
        "{ON}OCTO_ROUTER_BASE_URL=http://10.1.2.3:8080/autoroute/\n"
    ));
    let b = e.bridge(Some("ok"));
    b.url().unwrap();
    assert!(e.record("router").is_none());
    let h = e.record("harness").unwrap();
    let args = args_of(&h);
    let at = args.iter().position(|a| a == "--base-url").unwrap();
    assert_eq!(args[at + 1], "http://10.1.2.3:8080/autoroute");
    assert!(h["env"]["HARNESS_OCTO_KEY"].is_null());
    assert!(b.notices().is_empty());
    b.stop();
}

#[test]
fn shutdown_stops_the_harness_before_the_router() {
    need_python!();
    let e = Env::new("order");
    e.settings(ON);
    let b = e.bridge(Some("ok"));
    b.url().unwrap();
    b.stop();
    assert_eq!(e.order(), ["harness", "router"]);
    // Drop stops too, in the same order.
    let _ = std::fs::remove_file(e.dir.join("out/order.txt"));
    let b = e.bridge(Some("ok"));
    b.url().unwrap();
    drop(b);
    assert_eq!(e.order(), ["harness", "router"]);
}

#[test]
fn restart_picks_up_a_changed_settings_file() {
    need_python!();
    let e = Env::new("restart");
    let b = e.bridge(Some("ok"));

    // Off at first.
    b.url().unwrap();
    assert!(e.record("router").is_none());

    // Switched on: the restart starts the router and points the harness at it.
    e.settings(ON);
    b.restart().unwrap();
    let r = e.record("router").expect("router started by the restart");
    let port = port_of_router(&r);
    let args = args_of(&e.record("harness").unwrap());
    assert!(
        args.contains(&format!("http://127.0.0.1:{port}/autoroute")),
        "{args:?}"
    );
    assert!(b.notices().is_empty());

    // Switched to an external router: ours is stopped (after the harness), the URL is the external one.
    let _ = std::fs::remove_file(e.dir.join("out/order.txt"));
    e.forget("router");
    e.settings("OCTO_ROUTER_BASE_URL=http://example.test/autoroute\n");
    b.restart().unwrap();
    assert_eq!(e.order(), ["harness", "router"]);
    assert!(e.record("router").is_none());
    assert!(args_of(&e.record("harness").unwrap())
        .contains(&"http://example.test/autoroute".to_string()));

    // Off again.
    e.settings("OCTO_ROUTER_ENABLED=0\n");
    b.restart().unwrap();
    assert!(!args_of(&e.record("harness").unwrap()).contains(&"--base-url".to_string()));
    b.stop();
}

#[test]
fn a_failed_router_start_is_retried_by_the_next_restart_and_the_notice_clears() {
    need_python!();
    let e = Env::new("retry");
    e.settings(ON);
    let mut cfg = BridgeConfig::new(
        e.fake("harness", "ok"),
        e.dir.join("data"),
        e.dir.join("logs"),
        None,
    )
    .with_router(e.fake("router", "die"));
    cfg.health_timeout = Duration::from_secs(10);
    cfg.router_health_timeout = Duration::from_millis(1500);
    let b = Bridge::new(cfg);
    b.url().unwrap();
    assert_eq!(b.notices().len(), 1);
    // "Fix" the router binary in place (same path), then Retry.
    e.fake("router", "ok");
    b.restart().unwrap();
    assert!(b.notices().is_empty(), "{:?}", b.notices());
    assert!(e.record("router").is_some());
    b.stop();
}

#[test]
fn a_leftover_router_from_a_crashed_run_is_terminated_at_the_next_start() {
    need_python!();
    let e = Env::new("stale");
    e.settings(ON);
    // A process literally named `octo` (a copy of sleep) in its own group, recorded in router.pid.
    std::fs::create_dir_all(e.router_dir()).unwrap();
    let old = e.dir.join("octo");
    std::fs::copy("/bin/sleep", &old)
        .or_else(|_| std::fs::copy("/usr/bin/sleep", &old))
        .unwrap();
    use std::os::unix::process::CommandExt;
    let mut child = std::process::Command::new(&old)
        .arg("30")
        .process_group(0)
        .spawn()
        .unwrap();
    std::fs::write(
        e.router_dir().join("router.pid"),
        format!("{}\n", child.id()),
    )
    .unwrap();
    let b = e.bridge(Some("ok"));
    b.url().unwrap();
    let t0 = std::time::Instant::now();
    loop {
        if child.try_wait().unwrap().is_some() {
            break;
        }
        assert!(
            t0.elapsed() < Duration::from_secs(5),
            "the leftover router was not stopped"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(b.router_log_path().is_file());
    assert!(std::fs::read_to_string(b.router_log_path())
        .unwrap()
        .contains("left over from an earlier run"));
    b.stop();
}
