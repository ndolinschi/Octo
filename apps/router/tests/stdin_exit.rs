use std::io::{BufRead, BufReader, Cursor, Read, Write};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use octo::proxy::stdin_watch::{enabled, spawn, EXIT_ON_STDIN_CLOSE_ENV};

#[test]
fn only_the_value_one_enables_the_watcher() {
    assert!(enabled(Some("1")));
    assert!(enabled(Some(" 1 ")));
    for off in [None, Some(""), Some("0"), Some("true"), Some("yes")] {
        assert!(!enabled(off), "{off:?}");
    }
}

#[tokio::test]
async fn the_watcher_resolves_on_eof_and_discards_the_data_before_it() {
    let data = vec![b'x'; 100_000];
    tokio::time::timeout(Duration::from_secs(5), spawn(Cursor::new(data)))
        .await
        .expect("EOF must resolve the watcher")
        .unwrap();
}

struct Blocking(mpsc::Receiver<()>);

impl Read for Blocking {
    fn read(&mut self, _: &mut [u8]) -> std::io::Result<usize> {
        let _ = self.0.recv();
        Ok(0)
    }
}

#[tokio::test]
async fn the_watcher_stays_pending_while_the_input_is_open() {
    let (hold, gate) = mpsc::channel();
    let mut watcher = spawn(Blocking(gate));
    assert!(
        tokio::time::timeout(Duration::from_millis(300), &mut watcher)
            .await
            .is_err()
    );
    drop(hold);
    tokio::time::timeout(Duration::from_secs(5), watcher)
        .await
        .unwrap()
        .unwrap();
}

fn config_dir() -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "octo-stdin-exit-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let config = dir.join("config");
    std::fs::create_dir_all(&config).unwrap();
    for name in [
        "upstream.toml",
        "limits.toml",
        "openai.toml",
        "openrouter.toml",
        "anthropic.toml",
        "llm.toml",
        "decision.toml",
        "autoroute.toml",
        "prices.toml",
    ] {
        std::fs::copy(format!("config/{name}"), config.join(name)).unwrap();
    }
    std::fs::write(
        config.join("server.toml"),
        "[server]\nbind_addr = \"127.0.0.1:0\"\n",
    )
    .unwrap();
    std::fs::write(
        config.join("history.toml"),
        format!(
            "[history]\ndatabase_path = \"{}\"\n",
            dir.join("history.sqlite").display()
        ),
    )
    .unwrap();
    dir
}

fn start(dir: &std::path::Path, exit_on_close: bool) -> (Child, mpsc::Receiver<String>) {
    let mut command = Command::new(env!("CARGO_BIN_EXE_octo"));
    command
        .current_dir(dir)
        .env("OCTO_CONFIG", dir.join("config"))
        .env("OCTO_HISTORY_TOKEN_KEY", "test-key")
        .env("RUST_LOG", "info")
        .env_remove(EXIT_ON_STDIN_CLOSE_ENV)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    if exit_on_close {
        command.env(EXIT_ON_STDIN_CLOSE_ENV, "1");
    }
    let mut child = command.spawn().unwrap();
    let stdout = child.stdout.take().unwrap();
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if tx.send(line).is_err() {
                break;
            }
        }
    });
    (child, rx)
}

fn wait_for_line(rx: &mpsc::Receiver<String>, needle: &str) {
    let deadline = Instant::now() + Duration::from_secs(20);
    while Instant::now() < deadline {
        if let Ok(line) = rx.recv_timeout(Duration::from_millis(200)) {
            if line.contains(needle) {
                return;
            }
        }
    }
    panic!("never saw `{needle}` in the router output");
}

fn wait_for_exit(child: &mut Child, within: Duration) -> Option<std::process::ExitStatus> {
    let deadline = Instant::now() + within;
    while Instant::now() < deadline {
        if let Some(status) = child.try_wait().unwrap() {
            return Some(status);
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    None
}

#[test]
fn the_router_exits_gracefully_when_its_stdin_closes() {
    let dir = config_dir();
    let (mut child, rx) = start(&dir, true);
    wait_for_line(&rx, "listening");
    let mut stdin = child.stdin.take().unwrap();
    stdin.write_all(b"ignored input\n").unwrap();
    stdin.flush().unwrap();
    assert!(
        wait_for_exit(&mut child, Duration::from_millis(500)).is_none(),
        "input alone must not stop the router"
    );
    drop(stdin);
    let status = wait_for_exit(&mut child, Duration::from_secs(15));
    if status.is_none() {
        let _ = child.kill();
    }
    let status = status.expect("router must exit after stdin EOF");
    assert!(status.success(), "{status:?}");
    wait_for_line_opt(&rx, "stdin closed");
}

fn wait_for_line_opt(rx: &mpsc::Receiver<String>, needle: &str) {
    let mut seen = false;
    while let Ok(line) = rx.recv_timeout(Duration::from_millis(500)) {
        seen |= line.contains(needle);
    }
    assert!(seen, "shutdown reason `{needle}` was not logged");
}

#[test]
fn without_the_variable_a_closed_stdin_leaves_the_router_running() {
    let dir = config_dir();
    let (mut child, rx) = start(&dir, false);
    wait_for_line(&rx, "listening");
    drop(child.stdin.take());
    let exited = wait_for_exit(&mut child, Duration::from_secs(1));
    let _ = child.kill();
    let _ = child.wait();
    assert!(exited.is_none(), "router must keep running by default");
}
