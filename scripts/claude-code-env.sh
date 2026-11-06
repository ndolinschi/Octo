#!/usr/bin/env bash
# Sourceable Claude Code → local Octo /autoroute env (Mistral tiers).
#
# Usage (from repo root):
#   export OPENROUTER_API_KEY=sk-or-v1-...
#   source scripts/claude-code-env.sh
#   claude
#
# Key resolution order:
#   1) OPENROUTER_API_KEY already set
#   2) experiments/.env  (gitignored) with OPENROUTER_API_KEY=...
#   3) .env in repo root (gitignored)
#
# Requires Octo listening on OCTO_BIND (default 127.0.0.1:8080) with
# [llm.messages] backend = openrouter.

set -euo pipefail

_OCTO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export OCTO_BIND="${OCTO_BIND:-127.0.0.1:8080}"
_OCTO_BIND="${OCTO_BIND}"

_load_dotenv() {
  local file="$1"
  if [[ -f "$file" ]]; then
    # shellcheck disable=SC1090
    set -a
    # shellcheck disable=SC1090
    source "$file"
    set +a
  fi
}

_load_dotenv "${_OCTO_ROOT}/experiments/.env"
_load_dotenv "${_OCTO_ROOT}/.env"

if [[ -z "${OPENROUTER_API_KEY:-}" ]]; then
  echo "OPENROUTER_API_KEY is not set (export it or put it in experiments/.env)" >&2
  return 1 2>/dev/null || exit 1
fi

mkdir -p "${_OCTO_ROOT}/experiments"

# Autoroute base (Claude Code appends /v1/messages).
export ANTHROPIC_BASE_URL="${ANTHROPIC_BASE_URL:-http://${_OCTO_BIND}/autoroute}"
export ANTHROPIC_AUTH_TOKEN="${ANTHROPIC_AUTH_TOKEN:-$OPENROUTER_API_KEY}"
export ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-}"

# Claude Code model slots → Octo autoroute tiers (Mistral smaller → smarter).
export ANTHROPIC_DEFAULT_HAIKU_MODEL="${ANTHROPIC_DEFAULT_HAIKU_MODEL:-mistralai/ministral-8b-2512}"
export ANTHROPIC_DEFAULT_SONNET_MODEL="${ANTHROPIC_DEFAULT_SONNET_MODEL:-mistralai/mistral-small-3.1-24b-instruct}"
export ANTHROPIC_DEFAULT_OPUS_MODEL="${ANTHROPIC_DEFAULT_OPUS_MODEL:-mistralai/devstral-2512}"
export CLAUDE_CODE_SUBAGENT_MODEL="${CLAUDE_CODE_SUBAGENT_MODEL:-mistralai/ministral-8b-2512}"

export OCTO_ROOT="${_OCTO_ROOT}"
export OCTO_EXPERIMENTS_DIR="${_OCTO_ROOT}/experiments"

if [[ "${CLAUDE_CODE_ENV_QUIET:-}" != "1" ]]; then
  echo "ANTHROPIC_BASE_URL=$ANTHROPIC_BASE_URL"
  echo "HAIKU/low=$ANTHROPIC_DEFAULT_HAIKU_MODEL"
  echo "SONNET/mid=$ANTHROPIC_DEFAULT_SONNET_MODEL"
  echo "OPUS/high=$ANTHROPIC_DEFAULT_OPUS_MODEL"
  echo "SUBAGENT=$CLAUDE_CODE_SUBAGENT_MODEL"
  echo "cwd experiments → $OCTO_EXPERIMENTS_DIR"
fi
