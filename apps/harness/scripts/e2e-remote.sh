#!/usr/bin/env bash
# End-to-end check of remote access (docs/superpowers/specs/2026-11-14-remote-access-mobile-design.md) against a real
# `harness serve`, driven with curl: turn it on with a FAKE cloudflared (internal/remoteaccess/testdata/fake-cloudflared,
# which prints what a quick tunnel prints and never touches the network), pair a device, confirm it on the "computer",
# call the API with the device token through the second listener (no tunnel: the listener is on loopback), check the
# refused routes, revoke, turn off. Mock model; no network, no real cloudflared, no account. Needs Go and python3.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
TMP=$(mktemp -d)
PIDS=()
cleanup() { for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null || true; done; sleep 0.3; rm -rf "$TMP"; }
trap cleanup EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }
jget() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)"; }

LOCAL="e2e-local-$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
BASE=http://127.0.0.1:8842
REMOTE=http://127.0.0.1:8843
lc() { command curl -sS -H "Authorization: Bearer $LOCAL" "$@"; }                 # the computer (local token)
dc() { command curl -sS -H "Authorization: Bearer $DEVICE" "$@"; }                # the phone (device token)
code() { command curl -s -o /dev/null -w '%{http_code}' "$@"; }
errcode() { python3 -c "import json,sys; print(json.load(sys.stdin)['error']['code'])"; }
waitfor() { local what=$1; shift; for _ in $(seq 150); do "$@" >/dev/null 2>&1 && return; sleep 0.2; done; fail "timed out waiting for $what"; }

(cd "$ROOT/apps/harness" && go build -o "$TMP/harness" ./cmd/harness && go build -o "$TMP/mockllm" ./examples/mockllm)
mkdir -p "$TMP/bin" "$TMP/web"
cp "$ROOT/apps/harness/internal/remoteaccess/testdata/fake-cloudflared" "$TMP/bin/cloudflared"
chmod +x "$TMP/bin/cloudflared"
printf '<!doctype html><title>Octo web</title>\n' >"$TMP/web/index.html"
"$TMP/mockllm" --addr 127.0.0.1:8841 --delay 30ms >"$TMP/mock.log" 2>&1 & PIDS+=($!)
PATH="$TMP/bin:$PATH" HARNESS_API_TOKEN="$LOCAL" HARNESS_NO_BUILTIN_PLUGINS=1 ANTHROPIC_API_KEY=mock \
  HARNESS_REMOTE_ADDR=127.0.0.1:8843 HARNESS_REMOTE_WEB_DIR="$TMP/web" \
  "$TMP/harness" serve --addr 127.0.0.1:8842 --data-dir "$TMP/data" --base-url http://127.0.0.1:8841 >"$TMP/harness.log" 2>&1 & PIDS+=($!)
waitfor "the harness" command curl -fsS "$BASE/health"

echo "== off by default"
[ "$(lc "$BASE/v1/remote" | jget 'd["state"]')" = off ] || fail "remote access is not off at start"
[ "$(code "$REMOTE/health")" = 000 ] || fail "the tunnel listener is open while off"
[ ! -e "$TMP/bin/cloudflared.log" ] || fail "cloudflared ran while off"
[ "$(code "$BASE/v1/remote")" = 401 ] || fail "/v1/remote answered without the local token"

echo "== turning it on needs the acknowledgement the first time"
[ "$(lc -X POST "$BASE/v1/remote/enable" | errcode)" = remote_ack_required ] || fail "enable without acknowledge"
lc -X POST "$BASE/v1/remote/enable" -H 'content-type: application/json' -d '{"acknowledge":true}' >/dev/null
on() { [ "$(lc "$BASE/v1/remote" | jget 'd["state"]')" = on ]; }
waitfor "state on" on
ST=$(lc "$BASE/v1/remote")
[ "$(jget 'd["url"]' <<<"$ST")" = "https://fake-quick-tunnel-1.trycloudflare.com" ] || fail "url: $ST"
[ "$(jget 'd["listen"]' <<<"$ST")" = "127.0.0.1:8843" ] || fail "listen: $ST"
grep -q -- "tunnel --no-autoupdate --url http://127.0.0.1:8843" "$TMP/bin/cloudflared.log" || fail "cloudflared args: $(cat "$TMP/bin/cloudflared.log")"

echo "== the tunnel listener: web app, headers, no CORS, the local token is refused"
H=$(command curl -sS -D - -o /dev/null -H 'Origin: https://evil.example' "$REMOTE/")
grep -qi "content-security-policy: default-src 'self'" <<<"$H" || fail "no CSP on the web app: $H"
grep -qi 'x-content-type-options: nosniff' <<<"$H" || fail "no nosniff"
grep -qi 'referrer-policy: no-referrer' <<<"$H" || fail "no referrer policy"
! grep -qi 'access-control-' <<<"$H" || fail "CORS header on the tunnel listener"
[ "$(command curl -sS -H "Authorization: Bearer $LOCAL" "$REMOTE/v1/projects" | errcode)" = device_not_paired ] || fail "the local token worked through the tunnel"

echo "== pairing"
CODE=$(lc -X POST "$BASE/v1/remote/pairing" | jget 'd["pairing"]["code"]')
[[ "$CODE" =~ ^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$ ]] || fail "code shape: $CODE"
[ "$(command curl -sS -X POST "$REMOTE/pair/claim" -d '{"code":"ZZZZ-ZZZZ","name":"x"}' | errcode)" = pairing_code_invalid ] || fail "wrong code accepted"
[ "$(command curl -sS -X POST "$REMOTE/pair/claim" -d "{\"code\":\"$CODE\",\"name\":\"x\"}" | errcode)" = pairing_rate_limited ] || fail "no rate limit"
sleep 1.1
CLAIM=$(command curl -sS -X POST "$REMOTE/pair/claim" -d "{\"code\":\"$CODE\",\"name\":\"E2E phone\"}")
DEVICE=$(jget 'd["token"]' <<<"$CLAIM"); DEV_ID=$(jget 'd["device_id"]' <<<"$CLAIM")
[[ "$DEVICE" == octo_dev_* ]] || fail "claim: $CLAIM"
sleep 1.1
[ "$(command curl -sS -X POST "$REMOTE/pair/claim" -d "{\"code\":\"$CODE\",\"name\":\"y\"}" | errcode)" = pairing_code_invalid ] || fail "a code worked twice"
grep -q "$DEVICE" "$TMP/data/remote/devices.json" 2>/dev/null && fail "the token was stored in clear"
[ "$(dc "$REMOTE/v1/projects" | errcode)" = device_pending ] || fail "a pending device was let through"
[ "$(dc "$REMOTE/pair/me" | jget 'd["status"]')" = pending ] || fail "/pair/me pending"
[ "$(lc "$BASE/v1/remote" | jget 'd["pending"]')" = 1 ] || fail "the computer does not see the pending device"
lc -X POST "$BASE/v1/remote/devices/$DEV_ID/confirm" >/dev/null
[ "$(stat -c %a "$TMP/data/remote/devices.json")" = 600 ] || fail "devices.json mode"
grep -q "$DEVICE" "$TMP/data/remote/devices.json" && fail "the token was stored in clear"

echo "== the phone reads, sends, polls events and answers an approval"
mkdir -p "$TMP/proj" && printf '# demo\n' >"$TMP/proj/README.md"
PID=$(lc -X POST "$BASE/v1/projects" -H 'content-type: application/json' \
  -d "{\"name\":\"remote\",\"folders\":[{\"path\":\"$TMP/proj\"}],\"access\":\"supervised\"}" | jget 'd["id"]')
[ "$(dc "$REMOTE/v1/projects" | jget 'len(d["projects"])')" = 1 ] || fail "device project list"
STREAM=$(dc "$REMOTE/v1/projects/$PID/events/poll" | jget 'd["stream"]')
dc -X POST "$REMOTE/v1/projects/$PID/messages" -H 'content-type: application/json' -d '{"text":"Go [bash:echo hi > made.txt]"}' >/dev/null
EVS=$(dc "$REMOTE/v1/projects/$PID/events/poll?stream=$STREAM&wait=10")
[ "$(jget 'len(d["events"])' <<<"$EVS")" -ge 1 ] || fail "no events by long poll: $EVS"
has_approval() { [ "$(dc "$REMOTE/v1/projects/$PID/approvals" | jget 'len(d["approvals"])')" -ge 1 ]; }
waitfor "an approval" has_approval
AID=$(dc "$REMOTE/v1/projects/$PID/approvals" | jget 'd["approvals"][0]["id"]')
dc -X POST "$REMOTE/v1/projects/$PID/approvals/$AID" -H 'content-type: application/json' -d '{"decision":"allow"}' >/dev/null
made() { [ -f "$TMP/proj/made.txt" ]; }
waitfor "the approved command" made
idle() { # answers any further approval from the phone too
  for a in $(dc "$REMOTE/v1/projects/$PID/approvals" | jget '" ".join(x["id"] for x in d["approvals"])'); do
    dc -X POST "$REMOTE/v1/projects/$PID/approvals/$a" -H 'content-type: application/json' -d '{"decision":"allow"}' >/dev/null
  done
  [ "$(dc "$REMOTE/v1/projects/$PID" | jget 'd["status"]')" = idle ]
}
waitfor "idle" idle || { dc "$REMOTE/v1/projects/$PID"; exit 1; }

echo "== refused for a device"
for r in "PUT /v1/settings" "GET /v1/settings" "GET /v1/remote" "POST /v1/remote/disable" "POST /v1/projects" \
  "PATCH /v1/projects/$PID" "DELETE /v1/projects/$PID" "GET /v1/projects/$PID/secrets" "GET /v1/diagnostics" \
  "POST /v1/fs/pick-folder" "PUT /v1/projects/$PID/files/content"; do
  set -- $r
  [ "$(dc -X "$1" "$REMOTE$2" -H 'content-type: application/json' -d '{}' | errcode)" = remote_forbidden ] || fail "$r was not refused"
done
[ "$(command curl -sS "$REMOTE/v1/projects?token=$DEVICE" | errcode)" = query_token_refused ] || fail "token in the query accepted"
[ "$(dc -D - -o /dev/null "$REMOTE/v1/projects" | grep -ci 'cache-control: no-store')" = 1 ] || fail "API answers may be cached"

echo "== read-only device"
lc -X PATCH "$BASE/v1/remote/devices/$DEV_ID" -d '{"read_only":true}' >/dev/null
[ "$(dc -X POST "$REMOTE/v1/projects/$PID/messages" -d '{"text":"x"}' | errcode)" = remote_read_only ] || fail "read-only sent"
[ "$(code -H "Authorization: Bearer $DEVICE" "$REMOTE/v1/projects/$PID")" = 200 ] || fail "read-only cannot read"
lc -X PATCH "$BASE/v1/remote/devices/$DEV_ID" -d '{"read_only":false}' >/dev/null

echo "== revoke, revoke all and turn off"
lc -X DELETE "$BASE/v1/remote/devices/$DEV_ID" >/dev/null
[ "$(dc "$REMOTE/v1/projects" | errcode)" = device_not_paired ] || fail "a revoked device still works"
read -r CF_PID CF_HELPER <"$TMP/bin/cloudflared.pids"
ST=$(lc -X POST "$BASE/v1/remote/revoke-all")
[ "$(jget 'd["state"]' <<<"$ST")" = off ] && [ "$(jget 'len(d["devices"])' <<<"$ST")" = 0 ] || fail "revoke-all: $ST"
sleep 0.3
alive() { local st; st=$(ps -o stat= -p "$1" 2>/dev/null) && [[ "$st" != Z* ]]; } # a zombie is gone, only not reaped
alive "$CF_PID" && fail "cloudflared still runs"
alive "$CF_HELPER" && fail "cloudflared's process group still runs"
[ "$(code "$REMOTE/health")" = 000 ] || fail "the tunnel listener is still open"

echo "== doctor names cloudflared"
PATH="$TMP/bin:$PATH" HARNESS_NO_BUILTIN_PLUGINS=1 "$TMP/harness" doctor --data-dir "$TMP/doctor" | grep -q "cloudflared: found $TMP/bin/cloudflared (2025.1.0)" \
  || fail "doctor has no cloudflared line"

echo "e2e-remote: all passed"
