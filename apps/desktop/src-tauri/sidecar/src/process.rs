//! The harness child process: spawn in its own process group, pump its output to the log, stop the whole group.
//!
//! Not covered (documented in `apps/desktop/README.md`): if the app is SIGKILLed or crashes hard, nothing here runs.
//! Two partial nets exist. The child's stdout/stderr are pipes the app reads, so after the app dies the harness
//! gets SIGPIPE/EPIPE at its next log line and exits (its agent children in the same group then outlive it until
//! they finish). And the next launch reads `harness.pid` and, if that process is still alive and still named
//! `harness`, terminates its group before starting a new one. Windows has neither (no process groups here).

use crate::logfile::{pump, SharedLog};
use std::io;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

pub const STOP_GRACE: Duration = Duration::from_secs(3);

pub struct SpawnSpec<'a> {
    pub program: &'a Path,
    pub args: Vec<String>,
    /// Added to (or replacing) the inherited environment.
    pub env: Vec<(String, String)>,
    pub log: SharedLog,
}

pub struct Sidecar {
    child: Child,
    pumps: Vec<JoinHandle<()>>,
    stopped: bool,
}

impl Sidecar {
    pub fn spawn(spec: SpawnSpec<'_>) -> io::Result<Self> {
        let mut cmd = Command::new(spec.program);
        cmd.args(&spec.args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        for (k, v) in &spec.env {
            cmd.env(k, v);
        }
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            // New group, led by the child: everything it starts (ACP agents, language servers, bash tool) inherits it.
            cmd.process_group(0);
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        let mut child = cmd.spawn()?;
        let mut pumps = Vec::new();
        if let Some(out) = child.stdout.take() {
            let log = spec.log.clone();
            pumps.push(std::thread::spawn(move || pump(out, log)));
        }
        if let Some(err) = child.stderr.take() {
            let log = spec.log.clone();
            pumps.push(std::thread::spawn(move || pump(err, log)));
        }
        Ok(Self {
            child,
            pumps,
            stopped: false,
        })
    }

    pub fn pid(&self) -> u32 {
        self.child.id()
    }

    /// Some(description) once the leader has exited.
    pub fn exited(&mut self) -> Option<String> {
        match self.child.try_wait() {
            Ok(Some(status)) => Some(format!("the harness exited ({status})")),
            Ok(None) => None,
            Err(e) => Some(format!("cannot query the harness process: {e}")),
        }
    }

    /// SIGTERM to the group, wait up to `grace` for the leader and every group member to go, then SIGKILL the
    /// group. Idempotent.
    pub fn stop(&mut self, grace: Duration) {
        if self.stopped {
            return;
        }
        self.stopped = true;
        #[cfg(unix)]
        {
            let pgid = self.child.id() as i32;
            signal_group(pgid, libc::SIGTERM);
            let deadline = Instant::now() + grace;
            loop {
                let _ = self.child.try_wait(); // reap the leader, or the zombie keeps the group "alive"
                if !group_alive(pgid) || Instant::now() >= deadline {
                    break;
                }
                std::thread::sleep(Duration::from_millis(25));
            }
            if group_alive(pgid) {
                signal_group(pgid, libc::SIGKILL);
                // Killed members linger as zombies until init reaps them; give that a moment.
                let until = Instant::now() + Duration::from_secs(1);
                while group_alive(pgid) && Instant::now() < until {
                    let _ = self.child.try_wait();
                    std::thread::sleep(Duration::from_millis(10));
                }
            }
            let _ = self.child.wait();
        }
        #[cfg(not(unix))]
        {
            let _ = grace;
            let _ = Instant::now();
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
        // The pumps end when the pipes close, i.e. when every process in the group is gone.
        for h in self.pumps.drain(..) {
            let _ = h.join();
        }
    }
}

impl Drop for Sidecar {
    fn drop(&mut self) {
        self.stop(STOP_GRACE);
    }
}

#[cfg(unix)]
fn signal_group(pgid: i32, sig: i32) {
    if pgid > 1 {
        // SAFETY: signalling a process group we created; failure (ESRCH) is fine.
        unsafe { libc::killpg(pgid, sig) };
    }
}

/// True while any process of the group exists (a zombie counts, so reap the leader first).
#[cfg(unix)]
pub fn group_alive(pgid: i32) -> bool {
    if pgid <= 1 {
        return false;
    }
    // SAFETY: signal 0 only checks existence.
    let r = unsafe { libc::kill(-pgid, 0) };
    r == 0 || io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

// ---- pid file: cleanup after a crashed run -------------------------------------------------------------------

/// True when a `ps -o comm=` value names the harness binary (`harness`, `/path/to/harness`, `harness.exe`).
pub fn looks_like_harness(comm: &str) -> bool {
    let base = comm.trim().rsplit(['/', '\\']).next().unwrap_or("");
    base == "harness" || base == "harness.exe"
}

pub fn parse_pid(text: &str) -> Option<u32> {
    text.trim().parse::<u32>().ok().filter(|p| *p > 1)
}

pub fn write_pidfile(path: &Path, pid: u32) -> io::Result<()> {
    std::fs::write(path, format!("{pid}\n"))
}

/// Terminates the group of a harness left behind by an earlier, crashed run. Returns true when it killed one.
/// Safe against pid reuse: only a live process whose command name is `harness` is signalled.
#[cfg(unix)]
pub fn kill_stale(pidfile: &Path) -> bool {
    let Some(pid) = std::fs::read_to_string(pidfile)
        .ok()
        .as_deref()
        .and_then(parse_pid)
    else {
        let _ = std::fs::remove_file(pidfile);
        return false;
    };
    let _ = std::fs::remove_file(pidfile);
    let comm = Command::new("ps")
        .args(["-o", "comm=", "-p", &pid.to_string()])
        .output()
        .ok();
    let named = comm
        .map(|o| looks_like_harness(&String::from_utf8_lossy(&o.stdout)))
        .unwrap_or(false);
    if !named {
        return false;
    }
    let pgid = pid as i32;
    signal_group(pgid, libc::SIGTERM);
    let deadline = Instant::now() + Duration::from_secs(2);
    while group_alive(pgid) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(25));
    }
    if group_alive(pgid) {
        signal_group(pgid, libc::SIGKILL);
    }
    true
}

#[cfg(not(unix))]
pub fn kill_stale(pidfile: &Path) -> bool {
    let _ = std::fs::remove_file(pidfile);
    false
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::logfile::{tail_lines, CappedLog};
    use std::sync::{Arc, Mutex};

    fn tmp(name: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("octo-proc-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    /// True when no non-zombie process is left in the group. (`group_alive` also counts zombies, which linger in
    /// sandboxes whose PID 1 does not reap orphans; a zombie is not a running process.)
    fn group_dead(pgid: i32) -> bool {
        let out = Command::new("ps")
            .args(["-A", "-o", "pgid=,stat="])
            .output()
            .unwrap();
        !String::from_utf8_lossy(&out.stdout).lines().any(|l| {
            let mut it = l.split_whitespace();
            it.next().and_then(|p| p.parse::<i32>().ok()) == Some(pgid)
                && !it.next().unwrap_or("Z").starts_with('Z')
        })
    }

    fn spawn_sh(dir: &Path, script: &str) -> (Sidecar, SharedLog) {
        let log: SharedLog = Arc::new(Mutex::new(CappedLog::open(dir, "h.log", 1 << 20).unwrap()));
        let sc = Sidecar::spawn(SpawnSpec {
            program: Path::new("/bin/sh"),
            args: vec!["-c".into(), script.into()],
            env: vec![("OCTO_TEST_VAR".into(), "hello".into())],
            log: log.clone(),
        })
        .unwrap();
        (sc, log)
    }

    #[test]
    fn output_and_env_reach_the_log_and_exit_is_reported() {
        let d = tmp("out");
        let (mut sc, log) = spawn_sh(&d, "echo out-$OCTO_TEST_VAR; echo err-line >&2; exit 7");
        let t0 = Instant::now();
        let why = loop {
            if let Some(w) = sc.exited() {
                break w;
            }
            assert!(t0.elapsed() < Duration::from_secs(5));
            std::thread::sleep(Duration::from_millis(20));
        };
        assert!(why.contains('7'), "{why}");
        sc.stop(Duration::from_millis(200));
        let path = log.lock().unwrap().path().to_path_buf();
        let text = tail_lines(&path, 10);
        assert!(
            text.contains("out-hello") && text.contains("err-line"),
            "{text}"
        );
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn stop_terminates_the_leader_and_its_children() {
        let d = tmp("group");
        let (mut sc, _log) = spawn_sh(&d, "sleep 60 & sleep 60 & wait");
        let pgid = sc.pid() as i32;
        std::thread::sleep(Duration::from_millis(200));
        assert!(group_alive(pgid));
        let t0 = Instant::now();
        sc.stop(Duration::from_secs(3));
        assert!(
            t0.elapsed() < Duration::from_secs(2),
            "SIGTERM should be enough: {:?}",
            t0.elapsed()
        );
        assert!(group_dead(pgid), "the group must be gone");
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn a_process_that_ignores_sigterm_is_killed_after_the_grace() {
        let d = tmp("kill");
        let (mut sc, _log) = spawn_sh(&d, "trap '' TERM; while :; do sleep 1; done");
        let pgid = sc.pid() as i32;
        std::thread::sleep(Duration::from_millis(300));
        let t0 = Instant::now();
        sc.stop(Duration::from_millis(400));
        let took = t0.elapsed();
        assert!(
            took >= Duration::from_millis(400),
            "waited for the grace: {took:?}"
        );
        assert!(took < Duration::from_secs(3), "{took:?}");
        assert!(group_dead(pgid));
        sc.stop(Duration::from_millis(10)); // idempotent
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn a_background_child_that_outlives_the_leader_is_swept() {
        let d = tmp("sweep");
        // The leader exits at once; the child ignores TERM and stays in the group.
        let (mut sc, _log) = spawn_sh(&d, "(trap '' TERM; sleep 30) & exit 0");
        let pgid = sc.pid() as i32;
        std::thread::sleep(Duration::from_millis(300));
        sc.stop(Duration::from_millis(300));
        assert!(group_dead(pgid));
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn a_missing_binary_is_an_error() {
        let d = tmp("missing");
        let log: SharedLog = Arc::new(Mutex::new(CappedLog::open(&d, "h.log", 1 << 20).unwrap()));
        let r = Sidecar::spawn(SpawnSpec {
            program: Path::new("/nonexistent/harness"),
            args: vec![],
            env: vec![],
            log,
        });
        assert!(r.is_err());
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn pid_file_helpers() {
        assert_eq!(parse_pid("1234\n"), Some(1234));
        assert_eq!(parse_pid(""), None);
        assert_eq!(parse_pid("abc"), None);
        assert_eq!(parse_pid("0"), None);
        assert_eq!(parse_pid("1"), None);
        assert!(looks_like_harness(
            "/Applications/Octo.app/Contents/MacOS/harness\n"
        ));
        assert!(looks_like_harness("harness"));
        assert!(!looks_like_harness("harness-helper"));
        assert!(!looks_like_harness("zsh"));
        assert!(!looks_like_harness(""));
    }

    #[test]
    fn kill_stale_ignores_a_live_process_that_is_not_the_harness() {
        let d = tmp("stale");
        let mut other = Command::new("sleep").arg("30").spawn().unwrap();
        let pidfile = d.join("harness.pid");
        write_pidfile(&pidfile, other.id()).unwrap();
        assert!(
            !kill_stale(&pidfile),
            "a process named sleep must not be touched"
        );
        assert!(other.try_wait().unwrap().is_none());
        assert!(!pidfile.exists());
        let _ = other.kill();
        let _ = other.wait();
        // A stale file for a dead pid, and garbage, are both harmless.
        write_pidfile(&pidfile, other.id()).unwrap();
        assert!(!kill_stale(&pidfile));
        std::fs::write(&pidfile, "junk").unwrap();
        assert!(!kill_stale(&pidfile));
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn kill_stale_terminates_a_leftover_harness_group() {
        let d = tmp("stale2");
        // A process literally named `harness`: a copy of sleep in its own group.
        let bin = d.join("harness");
        std::fs::copy("/bin/sleep", &bin)
            .or_else(|_| std::fs::copy("/usr/bin/sleep", &bin))
            .unwrap();
        let log: SharedLog = Arc::new(Mutex::new(CappedLog::open(&d, "h.log", 1 << 20).unwrap()));
        let mut sc = Sidecar::spawn(SpawnSpec {
            program: &bin,
            args: vec!["30".into()],
            env: vec![],
            log,
        })
        .unwrap();
        let pidfile = d.join("harness.pid");
        write_pidfile(&pidfile, sc.pid()).unwrap();
        assert!(kill_stale(&pidfile));
        let t0 = Instant::now();
        while sc.exited().is_none() {
            assert!(t0.elapsed() < Duration::from_secs(3));
            std::thread::sleep(Duration::from_millis(20));
        }
        sc.stop(Duration::from_millis(100));
        let _ = std::fs::remove_dir_all(d);
    }
}
