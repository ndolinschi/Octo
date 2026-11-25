//! Free loopback port choice.

use std::io;
use std::net::TcpListener;

/// Asks the OS for a free port on 127.0.0.1 and releases it. Another process can in principle grab it before the
/// harness binds; the harness then fails to start and the caller reports that (and Retry picks a new port).
pub fn pick_free_port() -> io::Result<u16> {
    let listener = TcpListener::bind(("127.0.0.1", 0))?;
    Ok(listener.local_addr()?.port())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn port_is_nonzero_and_bindable() {
        let p = pick_free_port().unwrap();
        assert_ne!(p, 0);
        TcpListener::bind(("127.0.0.1", p)).expect("the port is free again after picking");
    }

    #[test]
    fn a_busy_port_is_not_returned() {
        let held = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let busy = held.local_addr().unwrap().port();
        for _ in 0..20 {
            assert_ne!(pick_free_port().unwrap(), busy);
        }
    }
}
