#!/usr/bin/env bash
# Sourceable Claude Code → local Octo /autoroute env (Mistral tiers).
#
# Usage (from repo root):
#   cp .env.example .env    # once; put real OPENROUTER_API_KEY there
#   source scripts/claude-code-env.sh
#   claude
#
# Loads (if present), in order — later wins for the same var:
#   1) experiments/.env
#   2) repo-root .env
# Non-placeholder already-exported OPENROUTER_API_KEY / ANTHROPIC_BASE_URL
# win over .env. Claude Code auth is always ANTHROPIC_AUTH_TOKEN =
# OPENROUTER_API_KEY (ANTHROPIC_API_KEY is unset).
#
# Requires Octo on OCTO_BIND (default 127.0.0.1:8080) with
# [llm.messages] backend = openrouter.
#
# Safe to `source`: does not leave `set -euo` or helper vars in your shell.

_OCTO_ENV_SOURCED=0
if [[ "${BASH_SOURCE[0]}" != "$0" ]]; then
  _OCTO_ENV_SOURCED=1
fi

# Remember only the options this script toggles; do not replay full $-
# (interactive shells include letters like i/s that `set -…` rejects).
_octo_had_e=0
_octo_had_u=0
case "$-" in *e*) _octo_had_e=1 ;; esac
case "$-" in *u*) _octo_had_u=1 ;; esac
set -eu

_octo_restore_shell_opts() {
  set +eu
  if [[ "${_octo_had_e}" -eq 1 ]]; then set -e; fi
  if [[ "${_octo_had_u}" -eq 1 ]]; then set -u; fi
}

# Example / truncated keys from .env.example must not win over a real key.
_octo_is_placeholder_key() {
  local key="${1-}"
  [[ -z "$key" ]] && return 0
  [[ "$key" == *... ]] && return 0
  [[ "$key" == "sk-or-v1-..." ]] && return 0
  # Real OpenRouter keys are much longer than the example stub.
  [[ ${#key} -lt 20 ]] && return 0
  return 1
}

_OCTO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export OCTO_BIND="${OCTO_BIND:-127.0.0.1:8080}"

_PRESERVE_OPENROUTER_API_KEY="${OPENROUTER_API_KEY-}"
_PRESERVE_ANTHROPIC_BASE_URL="${ANTHROPIC_BASE_URL-}"

_load_dotenv() {
  local file="$1"
  if [[ -f "$file" ]]; then
    set -a
    # shellcheck disable=SC1090
    source "$file"
    set +a
    if [[ "${CLAUDE_CODE_ENV_QUIET:-}" != "1" ]]; then
      echo "sourced $file"
    fi
  fi
}

_load_dotenv "${_OCTO_ROOT}/experiments/.env"
_load_dotenv "${_OCTO_ROOT}/.env"

# Prefer a non-placeholder shell OPENROUTER_API_KEY over .env (and over stubs).
if ! _octo_is_placeholder_key "${_PRESERVE_OPENROUTER_API_KEY}"; then
  OPENROUTER_API_KEY="${_PRESERVE_OPENROUTER_API_KEY}"
fi
[[ -n "${_PRESERVE_ANTHROPIC_BASE_URL}" ]] && ANTHROPIC_BASE_URL="${_PRESERVE_ANTHROPIC_BASE_URL}"

_octo_env_fail() {
  local msg="$1"
  echo "$msg" >&2
  _octo_restore_shell_opts
  unset -f _load_dotenv _octo_env_fail _octo_restore_shell_opts _octo_is_placeholder_key 2>/dev/null || true
  unset _OCTO_ROOT _PRESERVE_OPENROUTER_API_KEY _PRESERVE_ANTHROPIC_BASE_URL \
    _octo_had_e _octo_had_u _OCTO_ENV_SOURCED 2>/dev/null || true
  return 1
}

if _octo_is_placeholder_key "${OPENROUTER_API_KEY-}"; then
  _msg="OPENROUTER_API_KEY missing or still the .env.example placeholder (sk-or-v1-...). Put a real key in ${_OCTO_ROOT}/.env, then: unset ANTHROPIC_AUTH_TOKEN; source scripts/claude-code-env.sh"
  if [[ "${_OCTO_ENV_SOURCED}" -eq 1 ]]; then
    _octo_env_fail "$_msg" || return 1
  else
    echo "$_msg" >&2
    exit 1
  fi
fi

mkdir -p "${_OCTO_ROOT}/experiments"

export OPENROUTER_API_KEY
export ANTHROPIC_BASE_URL="${ANTHROPIC_BASE_URL:-http://${OCTO_BIND}/autoroute}"
# Claude Code reads AUTH_TOKEN for OpenRouter/Octo — keep it in sync with the key.
# Do not preserve a stale AUTH_TOKEN from a previous source of the placeholder.
export ANTHROPIC_AUTH_TOKEN="${OPENROUTER_API_KEY}"
# Claude Code warns if both auth vars exist; empty still counts as set.
unset ANTHROPIC_API_KEY

export ANTHROPIC_DEFAULT_HAIKU_MODEL="${ANTHROPIC_DEFAULT_HAIKU_MODEL:-mistralai/ministral-8b-2512}"
export ANTHROPIC_DEFAULT_SONNET_MODEL="${ANTHROPIC_DEFAULT_SONNET_MODEL:-mistralai/mistral-small-3.1-24b-instruct}"
export ANTHROPIC_DEFAULT_OPUS_MODEL="${ANTHROPIC_DEFAULT_OPUS_MODEL:-mistralai/devstral-2512}"
export CLAUDE_CODE_SUBAGENT_MODEL="${CLAUDE_CODE_SUBAGENT_MODEL:-mistralai/ministral-8b-2512}"

export OCTO_ROOT="${_OCTO_ROOT}"
export OCTO_EXPERIMENTS_DIR="${_OCTO_ROOT}/experiments"

if [[ "${CLAUDE_CODE_ENV_QUIET:-}" != "1" ]]; then
  echo "ANTHROPIC_BASE_URL=$ANTHROPIC_BASE_URL"
  echo "ANTHROPIC_AUTH_TOKEN=set (${#ANTHROPIC_AUTH_TOKEN} chars); ANTHROPIC_API_KEY=unset"
  echo "HAIKU/low=$ANTHROPIC_DEFAULT_HAIKU_MODEL"
  echo "SONNET/mid=$ANTHROPIC_DEFAULT_SONNET_MODEL"
  echo "OPUS/high=$ANTHROPIC_DEFAULT_OPUS_MODEL"
  echo "SUBAGENT=$CLAUDE_CODE_SUBAGENT_MODEL"
  echo "OPENROUTER_API_KEY=set (${#OPENROUTER_API_KEY} chars)"
  echo "OCTO_EXPERIMENTS_DIR=$OCTO_EXPERIMENTS_DIR (artifacts; repo stays accessible via --add-dir)"
fi

# Restore caller's shell options and drop helpers when sourced.
_octo_restore_shell_opts
unset -f _load_dotenv _octo_env_fail _octo_restore_shell_opts _octo_is_placeholder_key 2>/dev/null || true
unset _OCTO_ROOT _PRESERVE_OPENROUTER_API_KEY _PRESERVE_ANTHROPIC_BASE_URL \
  _octo_had_e _octo_had_u _OCTO_ENV_SOURCED 2>/dev/null || true
