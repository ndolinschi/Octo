#!/usr/bin/env bash
# Builds Octo (harness and router sidecars + Tauri app) and installs it.
#   macOS  -> /Applications/Octo.app  (--user: ~/Applications/Octo.app), ad-hoc signed
#   Linux  -> ~/.local/bin/octo (the AppImage) + ~/.local/share/applications/octo.desktop
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: scripts/install.sh [--user] [--sudo] [--no-install] [--help]

Checks the toolchains (pnpm, Node, Go, Rust; Xcode command-line tools on macOS; the WebKitGTK development
packages on Linux), builds the harness and the Octo router for this machine (both are bundled into the app),
runs the Tauri build and installs the app.

  --user         macOS: install to ~/Applications instead of /Applications
  --sudo         macOS: use sudo when the destination is not writable (otherwise the script stops and says so)
  --no-install   only build; print where the bundle is
  -h, --help     this text

Your data (projects, settings) lives outside the app (macOS: ~/Library/Application Support/com.ndolinschi.octo.desktop,
Linux: ~/.local/share/com.ndolinschi.octo.desktop) and survives reinstalling.
USAGE
}

USER_INSTALL=0
USE_SUDO=0
DO_INSTALL=1
while [[ $# -gt 0 ]]; do
  case "$1" in
    -h | --help) usage; exit 0 ;;
    --user) USER_INSTALL=1 ;;
    --sudo) USE_SUDO=1 ;;
    --no-install) DO_INSTALL=0 ;;
    *) echo "install.sh: unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OS="$(uname -s)"
case "$OS" in
  Darwin | Linux) ;;
  *) echo "install.sh: $OS is not supported (macOS and Linux only)" >&2; exit 1 ;;
esac

# --- toolchain check: collect everything that is missing, then say it once -----------------------------------------
MISSING=()
have() { command -v "$1" >/dev/null 2>&1; }
have node || MISSING+=("node: install Node.js 22+ (https://nodejs.org, or your version manager)")
have pnpm || MISSING+=("pnpm: install pnpm 10+ (corepack enable, or npm install -g pnpm)")
if [[ "$OS" == Darwin ]]; then
  have go || MISSING+=("go: install Go 1.26+ (brew install go)")
else
  have go || MISSING+=("go: install Go 1.26+ (bash scripts/install-go-toolchain.sh)")
fi
have rustc && have cargo || MISSING+=("rust: install the Rust toolchain from https://rustup.rs (rust-toolchain.toml pins the version)")
if [[ "$OS" == Darwin ]]; then
  xcode-select -p >/dev/null 2>&1 || MISSING+=("Xcode command-line tools: run  xcode-select --install")
  have codesign || MISSING+=("codesign: comes with the Xcode command-line tools (xcode-select --install)")
else
  if ! have pkg-config; then
    MISSING+=("pkg-config: install it (Debian/Ubuntu: sudo apt install pkg-config)")
  else
    WEBKIT_MISSING=()
    pkg-config --exists webkit2gtk-4.1 || WEBKIT_MISSING+=("webkit2gtk-4.1")
    pkg-config --exists gtk+-3.0 || WEBKIT_MISSING+=("gtk+-3.0")
    pkg-config --exists librsvg-2.0 || WEBKIT_MISSING+=("librsvg-2.0")
    if [[ ${#WEBKIT_MISSING[@]} -gt 0 ]]; then
      MISSING+=("Tauri system libraries (pkg-config cannot find: ${WEBKIT_MISSING[*]}). Install them:
      Debian/Ubuntu: sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev libssl-dev patchelf build-essential curl wget file
      Fedora:        sudo dnf install webkit2gtk4.1-devel gtk3-devel librsvg2-devel openssl-devel patchelf
      Arch:          sudo pacman -S webkit2gtk-4.1 gtk3 librsvg openssl patchelf base-devel
      (see https://v2.tauri.app/start/prerequisites/#linux)")
    fi
  fi
fi
if [[ ${#MISSING[@]} -gt 0 ]]; then
  echo "install.sh: cannot build Octo yet; missing:" >&2
  for m in "${MISSING[@]}"; do echo "  - $m" >&2; done
  exit 1
fi

cd "$ROOT"
if [[ ! -d node_modules ]]; then
  echo "install.sh: installing JavaScript dependencies (pnpm install)"
  pnpm install --frozen-lockfile
fi

echo "install.sh: building the sidecars (harness and router; the router needs a full Rust build the first time)"
env -u OCTO_NO_ROUTER bash "$ROOT/scripts/build-sidecar.sh"

if [[ "$OS" == Darwin ]]; then BUNDLES=app; else BUNDLES=appimage; fi
echo "install.sh: building the app (tauri build --bundles $BUNDLES); this takes a while the first time"
pnpm --filter @octo/desktop tauri build --bundles "$BUNDLES"

BUNDLE_DIR="$ROOT/apps/desktop/src-tauri/target/release/bundle"

# --- macOS ---------------------------------------------------------------------------------------------------------
install_macos() {
  local src dest dest_dir
  src="$(find "$BUNDLE_DIR/macos" -maxdepth 1 -name '*.app' -print -quit 2>/dev/null || true)"
  if [[ -z "$src" ]]; then
    echo "install.sh: the build finished but no .app is under $BUNDLE_DIR/macos" >&2
    exit 1
  fi
  echo "install.sh: built $src"
  [[ "$DO_INSTALL" -eq 1 ]] || return 0

  if [[ "$USER_INSTALL" -eq 1 ]]; then dest_dir="$HOME/Applications"; else dest_dir="/Applications"; fi
  dest="$dest_dir/Octo.app"
  mkdir -p "$dest_dir" 2>/dev/null || true
  local SUDO=()
  if [[ ! -w "$dest_dir" ]]; then
    if [[ "$USE_SUDO" -eq 1 ]]; then
      SUDO=(sudo)
    else
      echo "install.sh: $dest_dir is not writable by you. Re-run with --user to install into ~/Applications," >&2
      echo "            or with --sudo to use sudo for the copy." >&2
      exit 1
    fi
  fi
  if [[ -e "$dest" && ! -w "$dest" && ${#SUDO[@]} -eq 0 ]]; then
    echo "install.sh: $dest exists and is not writable by you (installed by another user?). Use --sudo, or --user." >&2
    exit 1
  fi

  echo "install.sh: quitting a running Octo (if any)"
  osascript -e 'quit app "Octo"' >/dev/null 2>&1 || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    pgrep -f "$dest/Contents/MacOS/" >/dev/null 2>&1 || break
    sleep 0.5
  done

  echo "install.sh: installing to $dest"
  ${SUDO[@]+"${SUDO[@]}"} rm -rf "$dest"
  ${SUDO[@]+"${SUDO[@]}"} ditto "$src" "$dest"
  # Ad-hoc signature: lets the app open without a developer certificate (the data directory is untouched).
  ${SUDO[@]+"${SUDO[@]}"} codesign --force --deep -s - "$dest"
  ${SUDO[@]+"${SUDO[@]}"} xattr -dr com.apple.quarantine "$dest" 2>/dev/null || true
  echo "install.sh: installed $dest (ad-hoc signed). Open it from Launchpad or: open -a Octo"
}

# --- Linux ---------------------------------------------------------------------------------------------------------
install_linux() {
  local src bin_dir apps_dir icon_dir
  src="$(find "$BUNDLE_DIR/appimage" -maxdepth 1 -name '*.AppImage' -print -quit 2>/dev/null || true)"
  if [[ -z "$src" ]]; then
    echo "install.sh: the build finished but no .AppImage is under $BUNDLE_DIR/appimage" >&2
    exit 1
  fi
  echo "install.sh: built $src"
  [[ "$DO_INSTALL" -eq 1 ]] || return 0

  bin_dir="$HOME/.local/bin"
  apps_dir="$HOME/.local/share/applications"
  icon_dir="$HOME/.local/share/icons/hicolor/128x128/apps"
  mkdir -p "$bin_dir" "$apps_dir" "$icon_dir"
  install -m 755 "$src" "$bin_dir/octo.new"
  mv -f "$bin_dir/octo.new" "$bin_dir/octo" # replaces a running copy without "text file busy"
  install -m 644 "$ROOT/apps/desktop/src-tauri/icons/128x128.png" "$icon_dir/octo.png"
  cat >"$apps_dir/octo.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=Octo
Comment=Project-based agent workspace
Exec=$bin_dir/octo
Icon=octo
Terminal=false
Categories=Development;
DESKTOP
  if have update-desktop-database; then update-desktop-database "$apps_dir" >/dev/null 2>&1 || true; fi
  echo "install.sh: installed $bin_dir/octo and $apps_dir/octo.desktop"
  case ":$PATH:" in
    *":$bin_dir:"*) ;;
    *) echo "install.sh: note: $bin_dir is not on your PATH; start Octo from the application menu or $bin_dir/octo" ;;
  esac
}

if [[ "$OS" == Darwin ]]; then install_macos; else install_linux; fi
