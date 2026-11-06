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
# Octo on OCTO_BIND (default 127.0.0.1:8080). Recommended BASE_URL is
# /autoroute; plain OpenRouter Messages uses /openrouter (API root).
#
# Safe to `source`: does not enable `set -e` (that can kill an interactive
# shell on a bad .env). Executed as a script still uses `set -eu` + EXIT trap.

_OCTO_ENV_SOURCED=0
if [[ "${BASH_SOURCE[0]}" != "$0" ]]; then
  _OCTO_ENV_SOURCED=1
fi

_octo_had_e=0
_octo_had_u=0
_octo_had_a=0
case "$-" in *e*) _octo_had_e=1 ;; esac
case "$-" in *u*) _octo_had_u=1 ;; esac
case "$-" in *a*) _octo_had_a=1 ;; esac

_octo_restore_shell_opts() {
  set +aeu 2>/dev/null || true
  if [[ "${_octo_had_a}" -eq 1 ]]; then set -a; fi
  if [[ "${_octo_had_e}" -eq 1 ]]; then set -e; fi
  if [[ "${_octo_had_u}" -eq 1 ]]; then set -u; fi
}

_octo_cleanup_helpers() {
  unset -f _load_dotenv _octo_env_fail _octo_restore_shell_opts \
    _octo_is_placeholder_key _octo_cleanup_helpers _octo_on_exit 2>/dev/null || true
  unset _OCTO_ROOT _PRESERVE_OPENROUTER_API_KEY _PRESERVE_ANTHROPIC_BASE_URL \
    _PRESERVE_OPENROUTER_WAS_SET _octo_had_e _octo_had_u _octo_had_a \
    _OCTO_ENV_SOURCED 2>/dev/null || true
}

_octo_on_exit() {
  _octo_restore_shell_opts
  _octo_cleanup_helpers
}

# Example / truncated keys from .env.example must not win over a real key.
_octo_is_placeholder_key() {
  local key="${1-}"
  [[ -z "$key" ]] && return 0
  [[ "$key" == *... ]] && return 0
  [[ "$key" == "sk-or-v1-..." ]] && return 0
  [[ ${#key} -lt 20 ]] && return 0
  return 1
}

# When executed (not sourced), -eu + EXIT trap covers crashes.
# When sourced, never enable -e: a failing `source .env` must not kill the shell.
if [[ "${_OCTO_ENV_SOURCED}" -eq 0 ]]; then
  trap '_octo_on_exit' EXIT
  set -eu
fi

_OCTO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export OCTO_BIND="${OCTO_BIND:-127.0.0.1:8080}"

_PRESERVE_OPENROUTER_WAS_SET=0
if [[ -n "${OPENROUTER_API_KEY+x}" ]]; then
  _PRESERVE_OPENROUTER_WAS_SET=1
fi
_PRESERVE_OPENROUTER_API_KEY="${OPENROUTER_API_KEY-}"
_PRESERVE_ANTHROPIC_BASE_URL="${ANTHROPIC_BASE_URL-}"

_load_dotenv() {
  local file="$1"
  local status=0
  if [[ -f "$file" ]]; then
    set -a
    # shellcheck disable=SC1090
    source "$file" || status=$?
    set +a
    if [[ "$status" -ne 0 ]]; then
      echo "failed to source $file (status=$status)" >&2
      return "$status"
    fi
    if [[ "${CLAUDE_CODE_ENV_QUIET:-}" != "1" ]]; then
      echo "sourced $file"
    fi
  fi
  return 0
}

if ! _load_dotenv "${_OCTO_ROOT}/experiments/.env"; then
  if [[ "${_OCTO_ENV_SOURCED}" -eq 1 ]]; then
    _octo_restore_shell_opts
    _octo_cleanup_helpers
    return 1
  fi
  exit 1
fi
if ! _load_dotenv "${_OCTO_ROOT}/.env"; then
  if [[ "${_OCTO_ENV_SOURCED}" -eq 1 ]]; then
    _octo_restore_shell_opts
    _octo_cleanup_helpers
    return 1
  fi
  exit 1
fi

# Prefer a non-placeholder shell OPENROUTER_API_KEY over .env (and over stubs).
if ! _octo_is_placeholder_key "${_PRESERVE_OPENROUTER_API_KEY}"; then
  OPENROUTER_API_KEY="${_PRESERVE_OPENROUTER_API_KEY}"
fi
[[ -n "${_PRESERVE_ANTHROPIC_BASE_URL}" ]] && ANTHROPIC_BASE_URL="${_PRESERVE_ANTHROPIC_BASE_URL}"

_octo_env_fail() {
  local msg="$1"
  local sourced="${_OCTO_ENV_SOURCED}"
  echo "$msg" >&2
  # Roll back auth mutations so a stub from .env does not stick in the shell.
  if [[ "${_PRESERVE_OPENROUTER_WAS_SET}" -eq 1 ]]; then
    OPENROUTER_API_KEY="${_PRESERVE_OPENROUTER_API_KEY}"
    export OPENROUTER_API_KEY
  else
    unset OPENROUTER_API_KEY
  fi
  unset ANTHROPIC_AUTH_TOKEN ANTHROPIC_API_KEY
  _octo_restore_shell_opts
  _octo_cleanup_helpers
  if [[ "$sourced" -eq 1 ]]; then
    return 1
  fi
  # Executed mode: EXIT trap also runs; disarm to avoid double-cleanup.
  trap - EXIT 2>/dev/null || true
  exit 1
}

if _octo_is_placeholder_key "${OPENROUTER_API_KEY-}"; then
  _octo_env_fail "OPENROUTER_API_KEY missing or still the .env.example placeholder (sk-or-v1-...). Put a real key in ${_OCTO_ROOT}/.env, then: source scripts/claude-code-env.sh" || return 1
fi

mkdir -p "${_OCTO_ROOT}/experiments"

export OPENROUTER_API_KEY
export ANTHROPIC_BASE_URL="${ANTHROPIC_BASE_URL:-http://${OCTO_BIND}/autoroute}"
export ANTHROPIC_AUTH_TOKEN="${OPENROUTER_API_KEY}"
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

if [[ "${_OCTO_ENV_SOURCED}" -eq 0 ]]; then
  trap - EXIT
fi
_octo_restore_shell_opts
_octo_cleanup_helpers
