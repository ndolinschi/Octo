//! Waiting for `GET /health`. A tiny HTTP/1.0 client over `std::net` (no HTTP crate for one request to loopback).

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::time::{Duration, Instant};

pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(15);
const POLL: Duration = Duration::from_millis(100);

/// One probe: true when `GET /health` answers 200.
pub fn probe(addr: SocketAddr) -> bool {
    let Ok(mut s) = TcpStream::connect_timeout(&addr, Duration::from_millis(500)) else {
        return false;
    };
    let _ = s.set_read_timeout(Some(Duration::from_millis(800)));
    let _ = s.set_write_timeout(Some(Duration::from_millis(800)));
    let req = format!("GET /health HTTP/1.0\r\nHost: {addr}\r\nConnection: close\r\n\r\n");
    if s.write_all(req.as_bytes()).is_err() {
        return false;
    }
    let mut head = [0u8; 64];
    let mut n = 0;
    while n < 12 {
        match s.read(&mut head[n..]) {
            Ok(0) | Err(_) => break,
            Ok(k) => n += k,
        }
    }
    status_is_ok(&head[..n])
}

/// True for a status line like `HTTP/1.1 200 OK`.
pub fn status_is_ok(head: &[u8]) -> bool {
    let line = String::from_utf8_lossy(head);
    let mut it = line.split_whitespace();
    matches!((it.next(), it.next()), (Some(v), Some("200")) if v.starts_with("HTTP/"))
}

#[derive(Debug, PartialEq, Eq)]
pub enum WaitError {
    /// `/health` never answered 200 in time.
    Timeout,
    /// `gone` reported a reason (the process exited): stop waiting at once.
    Gone(String),
}

/// Polls until healthy. `gone` is called between probes and returns Some(reason) when waiting is pointless
/// (the harness process has exited).
pub fn wait_healthy(
    addr: SocketAddr,
    timeout: Duration,
    mut gone: impl FnMut() -> Option<String>,
) -> Result<(), WaitError> {
    let deadline = Instant::now() + timeout;
    loop {
        if probe(addr) {
            return Ok(());
        }
        if let Some(reason) = gone() {
            return Err(WaitError::Gone(reason));
        }
        if Instant::now() >= deadline {
            return Err(WaitError::Timeout);
        }
        std::thread::sleep(POLL);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    /// Serves `status` for every request on a fresh loopback port.
    fn fake_server(status: &'static str) -> SocketAddr {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = l.local_addr().unwrap();
        std::thread::spawn(move || {
            for stream in l.incoming().flatten() {
                let mut s = stream;
                let mut buf = [0u8; 512];
                let _ = s.read(&mut buf);
                let _ = write!(
                    s,
                    "HTTP/1.1 {status}\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok"
                );
            }
        });
        addr
    }

    #[test]
    fn status_line_parsing() {
        assert!(status_is_ok(b"HTTP/1.1 200 OK\r\n"));
        assert!(status_is_ok(b"HTTP/1.0 200"));
        assert!(!status_is_ok(b"HTTP/1.1 503 Service Unavailable"));
        assert!(!status_is_ok(b"SSH-2.0-OpenSSH"));
        assert!(!status_is_ok(b""));
    }

    #[test]
    fn healthy_server_is_detected() {
        let addr = fake_server("200 OK");
        assert!(probe(addr));
        assert_eq!(wait_healthy(addr, Duration::from_secs(2), || None), Ok(()));
    }

    #[test]
    fn unhealthy_server_times_out() {
        let addr = fake_server("503 Service Unavailable");
        let t0 = Instant::now();
        assert_eq!(
            wait_healthy(addr, Duration::from_millis(400), || None),
            Err(WaitError::Timeout)
        );
        assert!(t0.elapsed() >= Duration::from_millis(400));
    }

    #[test]
    fn nothing_listening_times_out() {
        let addr = {
            let l = TcpListener::bind("127.0.0.1:0").unwrap();
            l.local_addr().unwrap()
        };
        assert_eq!(
            wait_healthy(addr, Duration::from_millis(300), || None),
            Err(WaitError::Timeout)
        );
    }

    #[test]
    fn a_dead_process_aborts_the_wait_early() {
        let addr = {
            let l = TcpListener::bind("127.0.0.1:0").unwrap();
            l.local_addr().unwrap()
        };
        let t0 = Instant::now();
        let r = wait_healthy(addr, Duration::from_secs(10), || {
            Some("exited with status 1".into())
        });
        assert_eq!(r, Err(WaitError::Gone("exited with status 1".into())));
        assert!(t0.elapsed() < Duration::from_secs(2));
    }

    #[test]
    fn becomes_healthy_after_a_late_start() {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = l.local_addr().unwrap();
        drop(l);
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(400));
            let l = TcpListener::bind(addr).unwrap();
            for stream in l.incoming().flatten() {
                let mut s = stream;
                let mut buf = [0u8; 256];
                let _ = s.read(&mut buf);
                let _ = write!(s, "HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n");
            }
        });
        assert_eq!(wait_healthy(addr, Duration::from_secs(5), || None), Ok(()));
    }
}
