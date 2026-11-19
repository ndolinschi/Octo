//! Command-line flags that print and exit without starting the proxy.

/// The router's version: `CARGO_PKG_VERSION` of this crate, the one number shared with the harness and the desktop app.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// What `octo --help` prints.
pub fn help() -> String {
    format!(
        "octo {VERSION}: the Octo HTTP proxy and model router\n\n\
         usage: octo [--version | --help]\n\n\
         With no arguments it starts the proxy. Configuration: $OCTO_CONFIG (a directory holding server.toml),\n\
         else ./config; see apps/router/docs/README.md.\n"
    )
}

/// The text to print and exit with for the given arguments (the program name excluded), or `None` to start the
/// proxy. `Err` is an argument it does not know, with the help text.
pub fn action<I: IntoIterator<Item = String>>(args: I) -> Option<Result<String, String>> {
    let first = args.into_iter().next()?;
    Some(match first.as_str() {
        "--version" | "-V" | "version" => Ok(format!("octo {VERSION}\n")),
        "--help" | "-h" | "help" => Ok(help()),
        other => Err(format!("octo: unknown argument {other:?}\n\n{}", help())),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(args: &[&str]) -> Option<Result<String, String>> {
        action(args.iter().map(|s| s.to_string()))
    }

    #[test]
    fn version_and_help_print_and_never_start() {
        assert_eq!(run(&["--version"]), Some(Ok(format!("octo {VERSION}\n"))));
        assert!(run(&["--help"]).unwrap().unwrap().contains("usage: octo"));
        assert!(run(&["-h"]).unwrap().is_ok());
        assert!(run(&["--bogus"]).unwrap().is_err());
        assert_eq!(run(&[]), None);
    }
}
