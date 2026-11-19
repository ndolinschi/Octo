//! Where the phone web client (`@octo/web`'s `dist`) is, so the harness can serve it to paired phones (Remote access)
//! without anyone setting `HARNESS_REMOTE_WEB_DIR` by hand.
//!
//! The app bundle ships the built client as a resource; the shell lists the places it may be ([`BridgeConfig`]'s
//! `web_dir_candidates`: the bundled resource first, then the source tree's `apps/web/dist` for `tauri dev`) and the
//! first one that holds an `index.html` is passed to the harness in `HARNESS_REMOTE_WEB_DIR`. A value the person set
//! (in `harness.env`, or in the environment the app was started with) always wins and is never replaced.
//!
//! [`BridgeConfig`]: crate::bridge::BridgeConfig

use std::path::{Path, PathBuf};

/// The variable the harness reads (`remoteaccess.EnvWebDir`).
pub const WEB_DIR_ENV: &str = "HARNESS_REMOTE_WEB_DIR";

/// The directory to hand the harness, or None when the person already chose (`user_set` names the variables of
/// `harness.env`; `process_value` is the app's own environment value) or no candidate holds a built client.
pub fn resolve_web_dir(
    candidates: &[PathBuf],
    user_set: &[String],
    process_value: Option<&str>,
) -> Option<PathBuf> {
    if user_set.iter().any(|k| k == WEB_DIR_ENV) || process_value.is_some() {
        return None;
    }
    candidates
        .iter()
        .find(|d| is_web_dir(d))
        .map(|d| d.to_path_buf())
}

fn is_web_dir(dir: &Path) -> bool {
    dir.join("index.html").is_file()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("octo-web-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn built(dir: &Path) -> PathBuf {
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(dir.join("index.html"), "<!doctype html>").unwrap();
        dir.to_path_buf()
    }

    #[test]
    fn the_first_candidate_with_an_index_wins() {
        let d = tmp("first");
        let empty = d.join("empty");
        std::fs::create_dir_all(&empty).unwrap();
        let bundled = built(&d.join("bundled"));
        let source = built(&d.join("source"));
        let got = resolve_web_dir(
            &[d.join("missing"), empty, bundled.clone(), source],
            &[],
            None,
        );
        assert_eq!(got, Some(bundled));
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn nothing_built_means_nothing_is_set() {
        let d = tmp("none");
        assert_eq!(resolve_web_dir(&[d.join("a"), d.clone()], &[], None), None);
        assert_eq!(resolve_web_dir(&[], &[], None), None);
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn a_value_the_person_set_is_never_replaced() {
        let d = tmp("user");
        let bundled = built(&d.join("bundled"));
        let c = [bundled];
        let file = vec!["OTHER".to_string(), WEB_DIR_ENV.to_string()];
        assert_eq!(resolve_web_dir(&c, &file, None), None, "harness.env wins");
        assert_eq!(
            resolve_web_dir(&c, &[], Some("")),
            None,
            "even an empty environment value wins"
        );
        assert!(resolve_web_dir(&c, &["OTHER".to_string()], None).is_some());
        let _ = std::fs::remove_dir_all(d);
    }
}
