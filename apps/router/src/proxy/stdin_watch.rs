use std::io::Read;

use tokio::sync::oneshot;

pub const EXIT_ON_STDIN_CLOSE_ENV: &str = "OCTO_EXIT_ON_STDIN_CLOSE";

pub fn enabled(raw: Option<&str>) -> bool {
    matches!(raw.map(str::trim), Some("1"))
}

/// Reads and discards `reader` on a detached thread; the receiver resolves on EOF or a read error.
/// A plain thread (not `spawn_blocking`) so a pending read never delays runtime or process exit.
pub fn spawn<R: Read + Send + 'static>(mut reader: R) -> oneshot::Receiver<()> {
    let (tx, rx) = oneshot::channel();
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(_) => {}
            }
        }
        let _ = tx.send(());
    });
    rx
}

pub async fn stdin_closed() {
    if !enabled(std::env::var(EXIT_ON_STDIN_CLOSE_ENV).ok().as_deref()) {
        std::future::pending::<()>().await;
    }
    let _ = spawn(std::io::stdin()).await;
}
