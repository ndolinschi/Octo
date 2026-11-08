#!/usr/bin/env bash
# Run Claude Code with Octo autoroute + Mistral tiers.
# Keys from apps/router .env (via claude-code-env.sh). Session/artifacts under experiments/;
# apps/router is added with --add-dir so reads of src/ still work.
#
# Usage (from apps/router):
#   cp .env.example .env   # once
#   ./scripts/claude-code-experiment.sh
#   ./scripts/claude-code-experiment.sh -p "Только чтение. …"
#   OCTO_CC_SKIP_PERMISSIONS=1 ./scripts/claude-code-experiment.sh
#   ./scripts/claude-code-experiment.sh -- --allowedTools Read,Glob,Grep,Agent
#
# Permissions:
#   -p (non-interactive) defaults to --dangerously-skip-permissions.
#   Interactive defaults to normal permission prompts.
#   Set OCTO_CC_SKIP_PERMISSIONS=1 to force skip; =0 to force prompts.
#
# Local Octo (/autoroute or /openrouter) must be running unless BASE_URL is remote.
# Set OCTO_CC_REQUIRE_LOCAL=0 to skip the health check.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck disable=SC1091
CLAUDE_CODE_ENV_QUIET=1 source "${ROOT}/scripts/claude-code-env.sh"

mkdir -p "${OCTO_EXPERIMENTS_DIR}"
cd "${OCTO_EXPERIMENTS_DIR}"

_octo_needs_local_health=1
case "${OCTO_CC_REQUIRE_LOCAL:-}" in
  0|false|FALSE|no|NO) _octo_needs_local_health=0 ;;
esac
case "${ANTHROPIC_BASE_URL}" in
  http://127.0.0.1:*|http://localhost:*|http://"[::1]":*) ;;
  *) _octo_needs_local_health=0 ;;
esac
if [[ "${_octo_needs_local_health}" -eq 1 ]]; then
  if ! curl -sf -m 2 "http://${OCTO_BIND}/health" >/dev/null; then
    echo "Octo health check failed at http://${OCTO_BIND}/health — start with: cd apps/router && cargo run" >&2
    exit 1
  fi
fi
unset _octo_needs_local_health

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

# App + monorepo access from experiments/ cwd; skip if caller already passed --add-dir.
ADD_DIR=()
has_add_dir=0
for arg in "${EXTRA[@]+"${EXTRA[@]}"}"; do
  if [[ "$arg" == "--add-dir" || "$arg" == --add-dir=* ]]; then
    has_add_dir=1
    break
  fi
done
if [[ "$has_add_dir" -eq 0 ]]; then
  MONOREPO_ROOT="$(cd "${ROOT}/.." && pwd)"
  ADD_DIR=(--add-dir "${OCTO_ROOT}" --add-dir "${MONOREPO_ROOT}")
fi

SKIP_PERMS=()
case "${OCTO_CC_SKIP_PERMISSIONS:-}" in
  1|true|TRUE|yes|YES)
    SKIP_PERMS=(--dangerously-skip-permissions)
    ;;
  0|false|FALSE|no|NO)
    SKIP_PERMS=()
    ;;
  *)
    # Default: skip only for non-interactive (-p) sandbox runs.
    if [[ "${PROMPT_MODE}" -eq 1 ]]; then
      SKIP_PERMS=(--dangerously-skip-permissions)
    fi
    ;;
esac

if [[ "${PROMPT_MODE}" -eq 1 ]]; then
  if [[ -n "${PROMPT}" ]]; then
    printf '%s' "${PROMPT}" | exec "${CLAUDE_BIN}" -p \
      "${SKIP_PERMS[@]}" \
      "${ADD_DIR[@]}" \
      "${EXTRA[@]}"
  else
    exec "${CLAUDE_BIN}" -p \
      "${SKIP_PERMS[@]}" \
      "${ADD_DIR[@]}" \
      "${EXTRA[@]}"
  fi
else
  exec "${CLAUDE_BIN}" "${SKIP_PERMS[@]}" "${ADD_DIR[@]}" "${EXTRA[@]}"
fi
