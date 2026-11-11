//! A killed app must not leave its sidecar behind: the app keeps the child's stdin pipe open and never writes to it,
//! so when the app dies (even by SIGKILL, which runs no destructor) the OS closes it and a child that exits on stdin
//! EOF (what `--exit-on-stdin-close` / `*_EXIT_ON_STDIN_CLOSE=1` make the real sidecars do) goes away.
//!
//! The test binary plays both roles: run normally, it starts itself again with `OCTO_STUB_APP_DIR` set; that
//! second process is the "app": it spawns a fake sidecar through [`Sidecar`], reports the child's pid, and sleeps
//! until it is killed.
#![cfg(unix)]

use octo_sidecar::logfile::{CappedLog, SharedLog};
use octo_sidecar::process::{Sidecar, SpawnSpec};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const DIR_ENV: &str = "OCTO_STUB_APP_DIR";

/// True while `pid` exists and is not a zombie (zombies linger in sandboxes whose PID 1 does not reap).
fn running(pid: i32) -> bool {
    let out = Command::new("ps")
        .args(["-o", "stat=", "-p", &pid.to_string()])
        .output()
        .unwrap();
    let stat = String::from_utf8_lossy(&out.stdout);
    let stat = stat.trim();
    !stat.is_empty() && !stat.starts_with('Z')
}

fn wait_for(what: &str, mut f: impl FnMut() -> bool) {
    let t0 = Instant::now();
    while !f() {
        assert!(t0.elapsed() < Duration::from_secs(10), "timed out: {what}");
        std::thread::sleep(Duration::from_millis(25));
    }
}

fn read_pid(path: &Path) -> Option<i32> {
    std::fs::read_to_string(path).ok()?.trim().parse().ok()
}

/// The stub "app" role. Never returns normally.
fn play_app(dir: PathBuf) -> ! {
    let log: SharedLog = Arc::new(Mutex::new(
        CappedLog::open(&dir, "app.log", 1 << 20).unwrap(),
    ));
    let pid_file = dir.join("child.pid");
    // Exits when stdin reaches EOF, like a sidecar in "exit when stdin closes" mode. Waits on a `read`, not a sleep.
    let script = format!("echo $$ > '{}'; cat >/dev/null", pid_file.display());
    let _sc = Sidecar::spawn(SpawnSpec {
        program: Path::new("/bin/sh"),
        args: vec!["-c".into(), script],
        env: vec![],
        log,
    })
    .unwrap();
    std::fs::write(dir.join("app.ready"), "1").unwrap();
    std::thread::sleep(Duration::from_secs(120));
    std::process::exit(0);
}

#[test]
fn the_sidecar_exits_when_the_app_is_sigkilled() {
    if let Some(dir) = std::env::var_os(DIR_ENV) {
        play_app(PathBuf::from(dir));
    }
    let dir = std::env::temp_dir().join(format!("octo-stdin-close-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();

    let me = std::env::current_exe().unwrap();
    let mut app = Command::new(me)
        .args([
            "--exact",
            "the_sidecar_exits_when_the_app_is_sigkilled",
            "--test-threads=1",
        ])
        .env(DIR_ENV, &dir)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .unwrap();

    wait_for("the stub app to start its child", || {
        dir.join("app.ready").exists() && read_pid(&dir.join("child.pid")).is_some()
    });
    let child = read_pid(&dir.join("child.pid")).unwrap();
    std::thread::sleep(Duration::from_millis(300));
    assert!(running(child), "the child runs while the app lives");

    // SIGKILL: no destructor, no exit hook runs in the app.
    app.kill().unwrap();
    let _ = app.wait();

    wait_for("the child to exit after the app was killed", || {
        !running(child)
    });
    let _ = std::fs::remove_dir_all(&dir);
}
