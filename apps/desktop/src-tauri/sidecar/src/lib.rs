//! Everything the desktop shell needs to run the bundled `harness serve` as a child process.
//!
//! Deliberately free of the `tauri` crate: these modules compile and test on any machine, without the WebKit
//! system libraries. `src-tauri/src/lib.rs` is the thin glue that owns one [`Bridge`] and exposes it as commands.

pub mod bridge;
pub mod health;
pub mod logfile;
pub mod port;
pub mod process;
pub mod shellenv;

pub use bridge::{Bridge, BridgeConfig, Running};
