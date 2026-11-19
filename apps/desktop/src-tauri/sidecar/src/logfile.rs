//! Size-capped log file for the harness's stdout/stderr, plus a tail reader for the error screen.
//!
//! The child's pipes are pumped into a [`CappedLog`]: when the file passes `max_bytes` it is renamed to
//! `<name>.1` (replacing the previous one) and a fresh file starts, so disk use stays under about 2 x `max_bytes`.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

pub const DEFAULT_MAX_BYTES: u64 = 2 * 1024 * 1024;

pub struct CappedLog {
    path: PathBuf,
    max_bytes: u64,
    file: File,
    written: u64,
}

impl CappedLog {
    /// Opens `dir/name` for appending (creating `dir`), rotating first when it is already over the cap.
    /// The directory and the files are the user's alone (0700 / 0600 on Unix, also when they existed): the log quotes
    /// the harness's output.
    pub fn open(dir: &Path, name: &str, max_bytes: u64) -> io::Result<Self> {
        fs::create_dir_all(dir)?;
        make_private(dir, 0o700)?;
        let path = dir.join(name);
        let mut log = Self {
            file: open_append(&path)?,
            path,
            max_bytes: max_bytes.max(1),
            written: 0,
        };
        log.written = log.file.metadata()?.len();
        if log.written >= log.max_bytes {
            log.rotate()?;
        }
        Ok(log)
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    fn rotate(&mut self) -> io::Result<()> {
        let rotated = rotated_path(&self.path);
        let _ = fs::remove_file(&rotated);
        fs::rename(&self.path, &rotated)?;
        self.file = open_append(&self.path)?;
        self.written = 0;
        Ok(())
    }

    /// Appends a marker line (used to separate runs: "--- harness start ...").
    pub fn line(&mut self, text: &str) -> io::Result<()> {
        self.write_all(format!("{text}\n").as_bytes())
    }
}

impl Write for CappedLog {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        if self.written >= self.max_bytes {
            self.rotate()?;
        }
        self.file.write_all(buf)?;
        self.written += buf.len() as u64;
        Ok(buf.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        self.file.flush()
    }
}

fn open_append(path: &Path) -> io::Result<File> {
    let mut opts = OpenOptions::new();
    opts.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let file = opts.open(path)?;
    make_private(path, 0o600)?;
    Ok(file)
}

/// Sets `mode` on Unix (an existing log or directory may have been created wider); nothing elsewhere.
#[cfg(unix)]
fn make_private(path: &Path, mode: u32) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(mode))
}

#[cfg(not(unix))]
fn make_private(_path: &Path, _mode: u32) -> io::Result<()> {
    Ok(())
}

pub fn rotated_path(path: &Path) -> PathBuf {
    let mut s = path.as_os_str().to_owned();
    s.push(".1");
    PathBuf::from(s)
}

/// A log shared by the stdout and stderr pump threads.
pub type SharedLog = Arc<Mutex<CappedLog>>;

/// Copies `reader` into the shared log until EOF. Lines from the two streams interleave but never split mid-write.
pub fn pump<R: Read>(mut reader: R, log: SharedLog) {
    let mut buf = [0u8; 8192];
    while let Ok(n) = reader.read(&mut buf) {
        if n == 0 {
            break;
        }
        if let Ok(mut l) = log.lock() {
            let _ = l.write_all(&buf[..n]);
        }
    }
}

/// The last `n` lines of the file (lossy UTF-8; reads at most the final 64 KiB). Missing file gives "".
pub fn tail_lines(path: &Path, n: usize) -> String {
    const WINDOW: u64 = 64 * 1024;
    let Ok(mut f) = File::open(path) else {
        return String::new();
    };
    let Ok(len) = f.metadata().map(|m| m.len()) else {
        return String::new();
    };
    let start = len.saturating_sub(WINDOW);
    if f.seek(SeekFrom::Start(start)).is_err() {
        return String::new();
    }
    let mut bytes = Vec::new();
    if f.read_to_end(&mut bytes).is_err() {
        return String::new();
    }
    let text = String::from_utf8_lossy(&bytes);
    let mut lines: Vec<&str> = text.lines().collect();
    if start > 0 && !lines.is_empty() {
        lines.remove(0); // the window began mid-line
    }
    let from = lines.len().saturating_sub(n);
    lines[from..].join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("octo-log-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        d
    }

    #[test]
    fn writes_append_and_tail_returns_the_last_lines() {
        let d = tmp("tail");
        let mut log = CappedLog::open(&d, "h.log", 1 << 20).unwrap();
        for i in 0..50 {
            log.line(&format!("line {i}")).unwrap();
        }
        let tail = tail_lines(log.path(), 3);
        assert_eq!(tail, "line 47\nline 48\nline 49");
        assert_eq!(tail_lines(&d.join("missing"), 3), "");
        let _ = fs::remove_dir_all(d);
    }

    #[test]
    fn rotates_at_the_cap_and_keeps_one_old_file() {
        let d = tmp("rot");
        let mut log = CappedLog::open(&d, "h.log", 100).unwrap();
        for i in 0..40 {
            log.line(&format!("entry number {i:03}")).unwrap();
        }
        let size = |p: &Path| fs::metadata(p).unwrap().len();
        assert!(size(log.path()) < 100 + 20);
        assert!(rotated_path(log.path()).exists());
        assert!(!d.join("h.log.2").exists());
        assert!(tail_lines(log.path(), 1).contains("entry number 039"));
        let _ = fs::remove_dir_all(d);
    }

    /// The harness's output can quote prompts and tool output: the log is the user's alone (security review finding 6).
    #[cfg(unix)]
    #[test]
    fn the_log_and_its_directory_are_private_also_when_they_existed() {
        use std::os::unix::fs::PermissionsExt;
        let d = tmp("private");
        fs::create_dir_all(&d).unwrap();
        fs::set_permissions(&d, fs::Permissions::from_mode(0o755)).unwrap();
        fs::write(d.join("h.log"), b"old\n").unwrap();
        fs::set_permissions(d.join("h.log"), fs::Permissions::from_mode(0o644)).unwrap();
        let mut log = CappedLog::open(&d, "h.log", 10).unwrap();
        log.line("a line long enough to rotate").unwrap();
        log.line("next").unwrap();
        let mode = |p: &Path| fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&d), 0o700);
        assert_eq!(mode(log.path()), 0o600);
        assert_eq!(mode(&rotated_path(log.path())), 0o600);
        let fresh = tmp("private-new");
        let log = CappedLog::open(&fresh, "h.log", 10).unwrap();
        assert_eq!(mode(&fresh), 0o700);
        assert_eq!(mode(log.path()), 0o600);
        let _ = fs::remove_dir_all(d);
        let _ = fs::remove_dir_all(fresh);
    }

    #[test]
    fn an_oversized_existing_file_is_rotated_on_open() {
        let d = tmp("open");
        fs::create_dir_all(&d).unwrap();
        fs::write(d.join("h.log"), vec![b'x'; 500]).unwrap();
        let log = CappedLog::open(&d, "h.log", 100).unwrap();
        assert_eq!(fs::metadata(log.path()).unwrap().len(), 0);
        assert_eq!(fs::metadata(rotated_path(log.path())).unwrap().len(), 500);
        let _ = fs::remove_dir_all(d);
    }

    #[test]
    fn tail_handles_a_window_that_starts_mid_line() {
        let d = tmp("win");
        let mut log = CappedLog::open(&d, "h.log", 1 << 24).unwrap();
        for i in 0..20000 {
            log.line(&format!("a fairly long log line to pass the window {i}"))
                .unwrap();
        }
        let tail = tail_lines(log.path(), 2);
        assert_eq!(tail, "a fairly long log line to pass the window 19998\na fairly long log line to pass the window 19999");
        let _ = fs::remove_dir_all(d);
    }

    #[test]
    fn pump_copies_until_eof() {
        let d = tmp("pump");
        let log: SharedLog = Arc::new(Mutex::new(CappedLog::open(&d, "h.log", 1 << 20).unwrap()));
        pump(&b"one\ntwo\n"[..], log.clone());
        let path = log.lock().unwrap().path().to_path_buf();
        assert_eq!(tail_lines(&path, 5), "one\ntwo");
        let _ = fs::remove_dir_all(d);
    }
}
