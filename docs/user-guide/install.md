# Install

**There are no signed releases yet.** Today you build Octo from its source code with one command. A build is ad-hoc signed
on macOS, unsigned on Linux, and has no auto-update: to update, pull the new source and run the command again. Signed builds,
notarisation and an updater are planned, not built ([status](../superpowers/HANDOVER.md)). Windows is not supported by the
installer.

## What you need first

The installer checks these and lists everything that is missing in one message.

| Tool | Version | Notes |
| --- | --- | --- |
| Node.js | 22 or newer | |
| pnpm | 10 or newer | `corepack enable`, or `npm install -g pnpm` |
| Go | 1.26 or newer | Linux: `bash scripts/install-go-toolchain.sh`; macOS: `brew install go` |
| Rust | the version in `rust-toolchain.toml` | install from <https://rustup.rs> |
| macOS | Xcode command-line tools | `xcode-select --install` |
| Linux | the WebKitGTK development packages | the installer prints one install command per distribution (Debian and Ubuntu, Fedora, Arch) |

You also need the agents or keys you want to use; see [First run](first-run.md). Octo does not install agent programs.

## Build and install

From a clone of the repository:

```bash
git submodule update --init --recursive
pnpm install:app
```

`pnpm install:app` runs `scripts/install.sh`. It installs the JavaScript dependencies, builds the harness, the Octo router and the phone web client
for your machine (all three are bundled inside the app), builds the Tauri app, and installs it. The first build takes a while,
mostly the Rust build of the router.

| System | What you get | Where |
| --- | --- | --- |
| macOS | `Octo.app`, ad-hoc signed, with the download quarantine flag cleared | `/Applications/Octo.app`; `pnpm install:app -- --user` installs to `~/Applications`; `-- --sudo` uses `sudo` for a folder you cannot write |
| Linux | an AppImage | `~/.local/bin/octo`, plus a menu entry (`~/.local/share/applications/octo.desktop`) and an icon |

`pnpm install:app -- --no-install` only builds, and prints where the bundle is. An installed Octo that is running is replaced
(macOS quits it first).

**Verification.** The install on Linux was run by the owner. On macOS it was never run. The builds depend on the Tauri toolchain;
the app was not compiled in the environment where this guide was checked, so expect to fix a missing system library the first time.

## Starting and stopping

Open Octo from the menu or Launchpad, or run `octo` on Linux. Octo starts its local service itself. Closing the last window
quits the app on every platform, including macOS, and stops the service with it. If the app is killed, the service notices and
exits by itself.

## Your data survives a reinstall

Projects and settings live outside the app, so reinstalling or updating keeps them
([where](privacy-and-data.md#where-your-data-lives)). A newer Octo migrates an older project database forward, and keeps a backup
next to it for the migrations that change data in place (`project.sqlite.pre-v15`, `project.sqlite.pre-m6`). An older Octo refuses a database made by a newer one and leaves it untouched, so do not go back to an older build
after upgrading.

## Trying Octo without installing

To try the interface with no backend at all, run `pnpm dev:all -- --mock` from the clone and open the address it prints; that
is a development mode, described in the [repository README](../../README.md#try-it-in-two-minutes-no-api-key).
