#!/usr/bin/env bash
# Claude Code statusLine helper for Octo autoroute.
# Prints: octo <tier> <short model> $<cost> [<last_trigger>]
set -euo pipefail

OCTO_URL="${OCTO_URL:-http://127.0.0.1:8080}"
SESSION="${OCTO_SESSION:-}"
AUTH_HDR=()
if [[ -n "${OCTO_CLIENT_AUTH_KEY:-}" ]]; then
  AUTH_HDR=(-H "x-octo-key: ${OCTO_CLIENT_AUTH_KEY}")
fi

if [[ -n "$SESSION" ]]; then
  url="${OCTO_URL%/}/autoroute/status?session=${SESSION}"
else
  url="${OCTO_URL%/}/autoroute/status"
fi

json="$(curl -fsS "${AUTH_HDR[@]}" "$url" 2>/dev/null || true)"
if [[ -z "$json" ]]; then
  echo "octo offline"
  exit 0
fi

if command -v jq >/dev/null 2>&1; then
  tier="$(printf '%s' "$json" | jq -r '.tier // "unset"')"
  model="$(printf '%s' "$json" | jq -r '.model // ""')"
  cost="$(printf '%s' "$json" | jq -r '.cost_usd // 0')"
  trigger="$(printf '%s' "$json" | jq -r '.last_trigger // "none"')"
else
  tier="$(printf '%s' "$json" | sed -n 's/.*"tier"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)"
  model="$(printf '%s' "$json" | sed -n 's/.*"model"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)"
  cost="$(printf '%s' "$json" | sed -n 's/.*"cost_usd"[[:space:]]*:[[:space:]]*\([0-9.]*\).*/\1/p' | head -1)"
  trigger="$(printf '%s' "$json" | sed -n 's/.*"last_trigger"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)"
  tier="${tier:-unset}"
  cost="${cost:-0}"
  trigger="${trigger:-none}"
fi

short="${model##*/}"
short="${short#~}"
printf 'octo %s %s $%.4f [%s]\n' "$tier" "${short:-?}" "$cost" "$trigger"
