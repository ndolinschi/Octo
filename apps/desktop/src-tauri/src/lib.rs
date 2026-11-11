use octo_sidecar::{Bridge, BridgeConfig, Notice};
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{Manager, RunEvent};

/// Shared by the commands and the exit hook.
struct BridgeState(Arc<Bridge>);

/// Where a sidecar binary is. `tauri-build` copies `binaries/<name>-<triple>` to `<name>` next to the app executable
/// for `tauri dev` / `cargo build`, and the bundler puts it next to the executable in the package
/// (`Contents/MacOS/<name>`, `usr/bin/<name>`). `env_override` (`OCTO_HARNESS_BIN`, `OCTO_ROUTER_BIN`) overrides,
/// for experiments.
fn sidecar_path(name: &str, env_override: &str) -> PathBuf {
    if let Some(p) = std::env::var_os(env_override).filter(|p| !p.is_empty()) {
        return PathBuf::from(p);
    }
    let file = if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    };
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|d| d.join(&file)))
        .unwrap_or_else(|| PathBuf::from(file))
}

/// The harness URL for the webview: starts the harness on first call (or returns `OCTO_BRIDGE_URL`).
/// Blocking work runs off the UI thread; concurrent calls share one start.
#[tauri::command]
async fn bridge_url(state: tauri::State<'_, BridgeState>) -> Result<String, String> {
    let bridge = state.0.clone();
    tauri::async_runtime::spawn_blocking(move || bridge.url())
        .await
        .map_err(|e| e.to_string())?
}

/// Stops the harness and starts a fresh one (the "Retry" button).
#[tauri::command]
async fn bridge_restart(state: tauri::State<'_, BridgeState>) -> Result<String, String> {
    let bridge = state.0.clone();
    tauri::async_runtime::spawn_blocking(move || bridge.restart())
        .await
        .map_err(|e| e.to_string())?
}

/// The last `lines` lines of the harness log, for the failure screen.
#[tauri::command]
async fn bridge_log_tail(
    state: tauri::State<'_, BridgeState>,
    lines: Option<usize>,
) -> Result<String, String> {
    let bridge = state.0.clone();
    let n = lines.unwrap_or(20).clamp(1, 500);
    tauri::async_runtime::spawn_blocking(move || bridge.log_tail(n))
        .await
        .map_err(|e| e.to_string())
}

/// What the UI should mention without blocking: `[]`, or `[{ kind: "router_failed", message, log_tail }]` when the
/// router was switched on but did not start (the harness runs without it).
#[tauri::command]
async fn bridge_notices(state: tauri::State<'_, BridgeState>) -> Result<Vec<Notice>, String> {
    let bridge = state.0.clone();
    tauri::async_runtime::spawn_blocking(move || bridge.notices())
        .await
        .map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?.join("harness");
            let log_dir = app.path().app_log_dir()?;
            let override_url = std::env::var("OCTO_BRIDGE_URL").ok();
            let cfg = BridgeConfig::new(
                sidecar_path("harness", "OCTO_HARNESS_BIN"),
                data_dir,
                log_dir,
                override_url,
            )
            .with_router(sidecar_path("octo", "OCTO_ROUTER_BIN"));
            app.manage(BridgeState(Arc::new(Bridge::new(cfg))));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            bridge_url,
            bridge_restart,
            bridge_log_tail,
            bridge_notices
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|handle, event| {
        // Exit fires after the last window closed or on Cmd+Q; terminate the harness group, then the router's (SIGTERM, 3 s, SIGKILL).
        if let RunEvent::Exit = event {
            if let Some(state) = handle.try_state::<BridgeState>() {
                state.0.stop();
            }
        }
    });
}
