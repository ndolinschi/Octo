#!/usr/bin/env bash
# End-to-end check of multiple accounts per agent against a real `harness serve`, driven only with curl: the scripted
# agent (examples/fakeacp) is the base agent "fake"; its manifest says how a second login is kept apart
# (accounts.env OCTO_FAKEACP_LOGIN_FILE={dir}/login), how the login is checked (`fakeacp status`) and how to log in
# (`fakeacp login`). Six steps:
#   1. add an account: it starts not_logged_in
#   2. log in through the login routes (PTY output, one input line, the login event, a recheck)
#   3. a turn on acp:fake@two sees only its own folder
#   4. the limit markers end the turn with the "usage limit" notice and the switch_account action
#   5. PATCH the project to acp:fake and retry: a new agent session, the default account's own environment
#   6. rename keeps the id; remove with delete_data=true deletes the folder and the model is no longer offered
# Mock model + scripted agent; no network, no third-party agent CLI. Needs Go and python3.
# Ports: E2E_MOCK_PORT (8840) and E2E_HARNESS_PORT (8841); a busy default moves to the next free port, a busy port you
# set is an error. Waits are on state, not time: E2E_WAIT_SECS (default 120) bounds each one.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
TMP=$(mktemp -d)
PIDS=()
cleanup() { for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null || true; done; sleep 0.3; rm -rf "$TMP"; }
trap cleanup EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }
source "$ROOT/scripts/lib-ports.sh"
pick_port E2E_MOCK_PORT 8840; pick_port E2E_HARNESS_PORT 8841
WAIT=${E2E_WAIT_SECS:-120}

# Every harness started below gets this API token, every curl sends it.
export HARNESS_API_TOKEN="e2e-token-$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
curl() {
  command curl --max-time 30 -H "Authorization: Bearer $HARNESS_API_TOKEN" "$@"
}
jget() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)"; }

(cd "$ROOT/apps/harness" && go build -o "$TMP/harness" ./cmd/harness && go build -o "$TMP/fakeacp" ./examples/fakeacp \
  && go build -o "$TMP/mockllm" ./examples/mockllm)
"$TMP/mockllm" --addr 127.0.0.1:$E2E_MOCK_PORT --delay 1ms >"$TMP/mock.log" 2>&1 & PIDS+=($!)

REQLOG="$TMP/requests.log"
mkdir -p "$TMP/plugins/fake" "$TMP/ws" "$TMP/data"
printf '# E2E workspace\n' >"$TMP/ws/README.md"
cat >"$TMP/plugins/fake/plugin.json" <<JSON
{"name":"fake","version":"1","agents":[{"id":"fake","label":"Fake","command":"$TMP/fakeacp",
 "env":{"OCTO_FAKEACP_UNIQUE_SESSIONS":"1","OCTO_FAKEACP_REQUEST_LOG":"$REQLOG","OCTO_FAKEACP_REPORT_VALUES":"OCTO_FAKEACP_LOGIN_FILE"},
 "accounts":{"env":{"OCTO_FAKEACP_LOGIN_FILE":"{dir}/login"}},
 "auth":{"probe":["$TMP/fakeacp","status"],"notLoggedInExit":[1],"command":"fakeacp login",
  "login":[{"id":"login","label":"Fake account","args":["$TMP/fakeacp","login"]}]},
 "limitPatterns":["(?i)hit your usage limit"]}]}
JSON
BASE=http://127.0.0.1:$E2E_HARNESS_PORT
HARNESS_DEFAULT_ACCESS=full HARNESS_NO_BUILTIN_PLUGINS=1 ANTHROPIC_API_KEY=mock "$TMP/harness" serve --addr 127.0.0.1:$E2E_HARNESS_PORT \
  --data-dir "$TMP/data" --base-url http://127.0.0.1:$E2E_MOCK_PORT --plugins-dir "$TMP/plugins" >"$TMP/harness.log" 2>&1 & PIDS+=($!)
wait_http "$BASE/health" "$WAIT" "${PIDS[1]}" || fail "harness did not start: $(cat "$TMP/harness.log")"

post() { curl -fsS -X "$1" "$BASE$2" -H 'content-type: application/json' ${3:+-d "$3"}; }
provider() { # id -> prints the provider's JSON from GET /v1/providers ("" when absent)
  curl -fsS "$BASE/v1/providers" | python3 -c '
import json, sys
for p in json.load(sys.stdin)["providers"]:
    if p["id"] == sys.argv[1]:
        print(json.dumps(p)); break' "$1"
}
login_state() { # id -> asks the harness to check again, prints the provider's login state
  curl -fsS -X POST "$BASE/v1/providers/${1//@/%40}/recheck" >/dev/null
  provider "$1" | jget 'd.get("login","")'
}
idle() { # project: waits for status idle
  local end=$((SECONDS + WAIT)) s=""
  while [ $SECONDS -lt $end ]; do
    s=$(curl -fsS "$BASE/v1/projects/$1" | jget 'd["status"]')
    [ "$s" = idle ] && { sleep 0.3; [ "$(curl -fsS "$BASE/v1/projects/$1" | jget 'd["status"]')" = idle ] && return; }
    sleep 0.2
  done
  fail "project $1 did not go idle within ${WAIT}s (status $s): $(tail -n 5 "$TMP/harness.log")"
}
say() { # project text -> sends the message, waits for the turn to end, prints the orchestrator's text of that turn
  post POST "/v1/projects/$1/messages" "{\"text\":\"$2\"}" >/dev/null
  sleep 0.3; idle "$1"
  curl -fsS "$BASE/v1/projects/$1/agents/$ORCH/messages" | jget '
" ".join(c.get("text","") for m in d["messages"][max(i for i,m in enumerate(d["messages"]) if m["role"]=="user" and m["content"] and m["content"][0]["type"]=="text"):] if m["role"]=="assistant" for c in m["content"] if c["type"]=="text")'
}
orch_error() { curl -fsS "$BASE/v1/projects/$1/agents" | jget '[a for a in d["agents"] if not a["parent_id"]][0]["error"] or ""'; }
sessions_started() { grep -c '^session/new' "$REQLOG" 2>/dev/null || true; }

echo "== 1. add an account: it starts not_logged_in"
[ "$(login_state fake)" = not_logged_in ] || fail "the default account is not not_logged_in before any login: $(provider fake)"
ADD=$(post POST /v1/providers/fake/accounts '{"name":"Two"}') || fail "adding an account failed: $(curl -s -X POST "$BASE/v1/providers/fake/accounts" -H 'content-type: application/json' -d '{"name":"Two"}')"
[ "$(jget 'd["account"]["id"]' <<<"$ADD")" = two ] || fail "the account id is not 'two': $ADD"
[ "$(jget 'd["account"]["default"]' <<<"$ADD")" = False ] || fail "the new account is the default: $ADD"
[ "$(jget 'd["provider"]["id"]' <<<"$ADD")" = "fake@two" ] || fail "the provider id is not fake@two: $ADD"
DIR=$(jget 'd["account"]["dir"]' <<<"$ADD")
[ -d "$DIR" ] || fail "the account folder $DIR was not created"
case "$DIR" in */accounts/fake/two) ;; *) fail "the account folder is not under the data folder: $DIR" ;; esac
[ "$(login_state fake@two)" = not_logged_in ] || fail "fake@two is not not_logged_in: $(provider fake@two)"
provider fake@two | python3 -c '
import json, sys
p = json.load(sys.stdin)
assert p["base_id"] == "fake" and p["account"]["name"] == "Two" and not p["account"]["default"], p
assert [m["id"] for m in p["login_methods"]] == ["login"], p
' || fail "the provider lacks base_id, account or login_methods: $(provider fake@two)"
code=$(curl -s -o "$TMP/dup.json" -w '%{http_code}' -X POST "$BASE/v1/providers/fake/accounts" -H 'content-type: application/json' -d '{"name":"Two"}')
[ "$code" = 409 ] || fail "a second account named Two answered $code, want 409: $(cat "$TMP/dup.json")"

echo "== 2. log in through the routes"
LOGIN=$(post POST /v1/providers/fake%40two/login '{"cols":100,"rows":30}') || fail "starting the login failed"
LID=$(jget 'd["session_id"]' <<<"$LOGIN")
curl -sN --max-time "$WAIT" "$BASE/v1/providers/fake%40two/login/$LID/events" >"$TMP/login-sse.txt" 2>/dev/null & PIDS+=($!)
SSE_PID=$!
cat >"$TMP/login-out.py" <<'PY'
import base64, json, sys
text, ev = "", None
for line in open(sys.argv[1], encoding="utf-8", errors="replace"):
    line = line.rstrip("\n")
    if line.startswith("event: "):
        ev = line[7:]
    elif line.startswith("data: ") and ev == "output":
        text += base64.b64decode(json.loads(line[6:])["data"]).decode("utf-8", "replace")
sys.exit(0 if "https://fakeacp.example/login?code=FAKE-1234" in text and "FAKE-1234" in text else 1)
PY
wait_until "$WAIT" "the login output shows its link and code" python3 "$TMP/login-out.py" "$TMP/login-sse.txt"
[ ! -e "$DIR/login" ] || fail "the login file exists before the login finished"
post POST "/v1/providers/fake%40two/login/$LID/input" '{"data":"\r"}' >/dev/null
wait_until "$WAIT" "the login exits and reports ok" grep -q '"state":"ok"' "$TMP/login-sse.txt"
grep -q '^event: exit' "$TMP/login-sse.txt" || fail "the login stream has no exit event"
kill "$SSE_PID" 2>/dev/null || true
[ -f "$DIR/login" ] || fail "the login did not write $DIR/login"
[ "$(login_state fake@two)" = ok ] || fail "fake@two is not logged in after the login: $(provider fake@two)"
[ "$(login_state fake)" = not_logged_in ] || fail "the default account changed with another account's login: $(provider fake)"

echo "== 3. a turn on acp:fake@two sees only its own folder"
PID=$(post POST /v1/projects "{\"name\":\"accounts\",\"folders\":[{\"path\":\"$TMP/ws\"}],\"models\":{\"orchestrator\":\"acp:fake@two\"}}" | jget 'd["id"]') \
  || fail "creating a project on acp:fake@two failed"
ORCH=$(curl -fsS "$BASE/v1/projects/$PID" | jget 'd["orchestrator_agent_id"]')
T1=$(say "$PID" "hello")
echo "$T1"
grep -qF "OCTO_FAKEACP_LOGIN_FILE=$DIR/login." <<<"$T1" || fail "the turn on fake@two did not see its own folder ($DIR/login): $T1"
[ "$(orch_error "$PID")" = "" ] || fail "the turn on fake@two failed: $(orch_error "$PID")"

echo "== 4. a usage limit ends the turn with the switch_account action"
for marker in '[limit:rpc]' '[limit:agent_error]'; do
  curl -sN --max-time "$WAIT" "$BASE/v1/projects/$PID/events" >"$TMP/limit-sse.txt" 2>/dev/null & PIDS+=($!)
  LSSE=$!
  sleep 0.3
  say "$PID" "$marker please" >/dev/null
  sleep 0.5; kill "$LSSE" 2>/dev/null || true
  err=$(orch_error "$PID")
  [ "$err" = "Fake · Two has reached its usage limit." ] || fail "$marker: the turn did not end with the limit notice, it says: '$err'"
  grep -q '"action":"switch_account"' "$TMP/limit-sse.txt" || fail "$marker: no event carries the action switch_account: $(grep -c . "$TMP/limit-sse.txt") lines"
  provider fake@two | python3 -c '
import json, sys
p = json.load(sys.stdin)
assert p.get("limit") and p["limit"].get("reached_at"), p
' || fail "$marker: fake@two shows no limit: $(provider fake@two)"
done
[ "$(provider fake | jget 'd.get("limit")')" = None ] || fail "the default account shows the other account's limit: $(provider fake)"

echo "== 5. PATCH the project to the default account and retry: a new agent session"
BEFORE=$(sessions_started)
post PATCH "/v1/projects/$PID" '{"models":{"orchestrator":"acp:fake"}}' >/dev/null || fail "PATCH of the project models failed"
T2=$(say "$PID" "hello again")
echo "$T2"
grep -qF "OCTO_FAKEACP_LOGIN_FILE=unset." <<<"$T2" || fail "the retry on the default account did not run with its own environment: $T2"
[ "$(sessions_started)" -gt "$BEFORE" ] || fail "no new agent session (session/new) for the default account: $(cat "$REQLOG")"
[ "$(orch_error "$PID")" = "" ] || fail "the retry failed: $(orch_error "$PID")"

echo "== 6. rename keeps the id; remove with delete_data deletes the folder"
REN=$(post PATCH /v1/providers/fake%40two/account '{"name":"Second"}') || fail "rename failed"
[ "$(jget 'd["account"]["id"]' <<<"$REN")" = two ] && [ "$(jget 'd["account"]["name"]' <<<"$REN")" = Second ] || fail "rename changed the id or not the name: $REN"
provider fake@two | grep -q 'Second' || fail "the provider label does not show the new name: $(provider fake@two)"
code=$(curl -s -o "$TMP/del-default.json" -w '%{http_code}' -X DELETE "$BASE/v1/providers/fake/account")
[ "$code" = 409 ] || fail "removing the default account answered $code, want 409: $(cat "$TMP/del-default.json")"
RM=$(curl -fsS -X DELETE "$BASE/v1/providers/fake%40two/account?delete_data=true") || fail "remove failed"
[ "$(jget 'd["removed"]' <<<"$RM")" = "fake@two" ] && [ "$(jget 'd["deleted_dir"]' <<<"$RM")" = "$DIR" ] || fail "remove answered $RM"
[ ! -e "$DIR" ] || fail "the account folder $DIR is still there"
[ -z "$(provider fake@two)" ] || fail "fake@two is still listed: $(provider fake@two)"
code=$(curl -s -o "$TMP/gone.json" -w '%{http_code}' -X POST "$BASE/v1/projects" -H "Authorization: Bearer $HARNESS_API_TOKEN" -H 'content-type: application/json' \
  -d "{\"name\":\"gone\",\"folders\":[{\"path\":\"$TMP/ws\"}],\"models\":{\"orchestrator\":\"acp:fake@two\"}}")
[ "$code" = 400 ] || fail "a project on the removed account answered $code, want 400: $(cat "$TMP/gone.json")"

kill -TERM "${PIDS[1]}"
for _ in $(seq 100); do kill -0 "${PIDS[1]}" 2>/dev/null || break; sleep 0.1; done
! pgrep -f "$TMP/fakeacp" >/dev/null || fail "fakeacp processes remain after shutdown"
echo "OK: accounts e2e passed"
