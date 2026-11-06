#!/usr/bin/env bash
# Run Claude Code with Octo autoroute + Mistral tiers.
# Keys from repo .env (via claude-code-env.sh). Session/artifacts under experiments/;
# repo root is added with --add-dir so reads of src/ still work.
#
# Usage:
#   cp .env.example .env   # once
#   ./scripts/claude-code-experiment.sh
#   ./scripts/claude-code-experiment.sh -p "Только чтение. …"
#   ./scripts/claude-code-experiment.sh -- --allowedTools Read,Glob,Grep,Agent
#
# Octo must already be running (cargo run) with autoroute on :8080.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck disable=SC1091
CLAUDE_CODE_ENV_QUIET=1 source "${ROOT}/scripts/claude-code-env.sh"

mkdir -p "${OCTO_EXPERIMENTS_DIR}"
cd "${OCTO_EXPERIMENTS_DIR}"

if ! curl -sf -m 2 "http://${OCTO_BIND}/health" >/dev/null; then
  echo "Octo health check failed at http://${OCTO_BIND}/health — start with: cargo run" >&2
  exit 1
fi

CLAUDE_BIN="${CLAUDE_BIN:-claude}"
if ! command -v "${CLAUDE_BIN}" >/dev/null 2>&1; then
  echo "claude binary not found (set CLAUDE_BIN)" >&2
  exit 1
fi

EXTRA=()
PROMPT_MODE=0
PROMPT=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -p|--print)
      PROMPT_MODE=1
      shift
      if [[ $# -gt 0 && "$1" != --* ]]; then
        PROMPT="$1"
        shift
      fi
      ;;
    --)
      shift
      EXTRA+=("$@")
      break
      ;;
    *)
      EXTRA+=("$1")
      shift
      ;;
  esac
done

# Repo access from experiments/ cwd; skip if caller already passed --add-dir.
ADD_DIR=()
has_add_dir=0
for arg in "${EXTRA[@]+"${EXTRA[@]}"}"; do
  if [[ "$arg" == "--add-dir" || "$arg" == --add-dir=* ]]; then
    has_add_dir=1
    break
  fi
done
if [[ "$has_add_dir" -eq 0 ]]; then
  ADD_DIR=(--add-dir "${OCTO_ROOT}")
fi

if [[ "${PROMPT_MODE}" -eq 1 ]]; then
  if [[ -n "${PROMPT}" ]]; then
    printf '%s' "${PROMPT}" | exec "${CLAUDE_BIN}" -p \
      --dangerously-skip-permissions \
      "${ADD_DIR[@]}" \
      "${EXTRA[@]}"
  else
    exec "${CLAUDE_BIN}" -p \
      --dangerously-skip-permissions \
      "${ADD_DIR[@]}" \
      "${EXTRA[@]}"
  fi
else
  exec "${CLAUDE_BIN}" --dangerously-skip-permissions "${ADD_DIR[@]}" "${EXTRA[@]}"
fi
