#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ -z "${OPENROUTER_API_KEY:-}" ]]; then
  echo "OPENROUTER_API_KEY is not set" >&2
  exit 1
fi

BASE="${1:-http://127.0.0.1:8080}"

chat() {
  local name="$1" model="$2"
  echo "--- chat: $name ($model) ---"
  code=$(curl -sS -o /tmp/octo-smoke-body.json -w "%{http_code}" \
    "$BASE/openrouter/completions" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $OPENROUTER_API_KEY" \
    -d "{\"model\":\"$model\",\"messages\":[{\"role\":\"user\",\"content\":\"Reply with one word: ok\"}],\"max_tokens\":16}")
  echo "HTTP $code"
  head -c 280 /tmp/octo-smoke-body.json
  echo
}

decision() {
  echo "--- decisions: typesafe/jev-1.13 ---"
  code=$(curl -sS -o /tmp/octo-smoke-decision.json -w "%{http_code}" \
    "$BASE/v1/decisions" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $OPENROUTER_API_KEY" \
    -d '{"model":"typesafe/jev-1.13","state":{"ticket":"Checkout blank after Pay"},"questions":{"is_bug":{"type":"noul","instructions":"Is this a bug report?","criteria":{"true":"broken behavior","false":"not a bug"}}}}')
  echo "HTTP $code"
  head -c 400 /tmp/octo-smoke-decision.json
  echo
}

chat "gemma-4-paid" "google/gemma-4-26b-a4b-it"
chat "gemma-2-free" "google/gemma-2-9b-it:free"
decision

sleep 2
if [[ -f data/history.sqlite ]]; then
  echo "--- history (last 5) ---"
  sqlite3 data/history.sqlite <<'SQL'
.headers on
.mode column
SELECT id, kind, provider, model, status, input_tokens, output_tokens, cost_micros,
       json_extract(request_payload, '$.payload.format') AS req_fmt,
       json_extract(response_payload, '$.payload.format') AS resp_fmt
FROM calls ORDER BY id DESC LIMIT 5;
SQL
fi
