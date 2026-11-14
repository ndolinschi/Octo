#!/usr/bin/env bash
# End-to-end check of parallel sessions, phase 1 (spec docs/superpowers/specs/2026-11-14-parallel-sessions-design.md),
# against a real `harness serve`, driven only with curl: two sessions of one project streaming at once (the mock
# model's [hold:NAME] marker keeps a reply open until POST /v1/mock/release), a message to a busy session queues only
# there, stopping one session, the project's running cap (waiting_for "slot"), the default-session aliases
# (/messages, /queue, /cancel, /clear, /default and /resume), GET /v1/sessions, and a restart after a kill -9 with
# two running sessions (both closed interrupted, both queues paused).
# Mock model only; no network, no third-party agent CLI. Needs Go and python3.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
TMP=$(mktemp -d)
PIDS=()
cleanup() { for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null || true; done; sleep 0.3; rm -rf "$TMP"; }
trap cleanup EXIT
fail() { echo "FAIL: $*" >&2; [ -f "$TMP/harness.log" ] && tail -30 "$TMP/harness.log" >&2; exit 1; }

export HARNESS_API_TOKEN="e2e-token-$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
MOCK=http://127.0.0.1:8870
BASE=http://127.0.0.1:8871
curl() {
  case "$*" in
    *127.0.0.1:8870*) command curl "$@" ;;
    *) command curl -H "Authorization: Bearer $HARNESS_API_TOKEN" "$@" ;;
  esac
}
jget() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)"; }
post() { curl -fsS -X "$1" "$BASE$2" -H 'content-type: application/json' ${3:+-d "$3"}; }
code() { curl -s -o "$TMP/body" -w '%{http_code}' -X "$1" "$BASE$2" -H 'content-type: application/json' ${3:+-d "$3"}; }
waitfor() { # description, command... : retries for ~30s
  local what=$1; shift
  for _ in $(seq 300); do "$@" >/dev/null 2>&1 && return; sleep 0.1; done
  fail "timed out waiting for $what"
}
held() { [ "$(command curl -fsS "$MOCK/v1/mock/held?name=$1")" = "$2" ]; }
release() { command curl -fsS -X POST "$MOCK/v1/mock/release?name=$1" >/dev/null; }
state() { curl -fsS "$BASE/v1/projects/$1/sessions/$2" | jget 'd["session"]["state"]'; }
is_state() { [ "$(state "$1" "$2")" = "$3" ]; }
qlen() { curl -fsS "$BASE/v1/projects/$1/sessions/$2/queue" | jget 'len(d["messages"])'; }

(cd "$ROOT/apps/harness" && go build -o "$TMP/harness-e2e-sessions" ./cmd/harness && go build -o "$TMP/mockllm-e2e-sessions" ./examples/mockllm)
"$TMP/mockllm-e2e-sessions" --addr 127.0.0.1:8870 --delay 20ms >"$TMP/mock.log" 2>&1 & PIDS+=($!)
start_harness() {
  HARNESS_NO_BUILTIN_PLUGINS=1 ANTHROPIC_API_KEY=mock "$TMP/harness-e2e-sessions" serve --addr 127.0.0.1:8871 --data-dir "$TMP/data" \
    --base-url "$MOCK" >>"$TMP/harness.log" 2>&1 &
  HPID=$!
  PIDS+=($HPID)
  for _ in $(seq 100); do curl -fsS "$BASE/health" >/dev/null 2>&1 && return; sleep 0.1; done
  fail "harness did not start"
}
start_harness
for _ in $(seq 50); do command curl -s -o /dev/null "$MOCK/v1/mock/held" && break; sleep 0.1; done

newproject() {
  mkdir -p "$TMP/$1" && printf '# demo\n' >"$TMP/$1/README.md"
  post POST /v1/projects "{\"name\":\"$1\",\"access\":\"full\",\"folders\":[{\"path\":\"$TMP/$1\"}]}" | jget 'd["id"]'
}
P=$(newproject alpha)
S1=$(curl -fsS "$BASE/v1/projects/$P/sessions?kind=main" | jget '[s["id"] for s in d["sessions"] if s["default"]][0]')

echo "== a new session is not the default (criterion 4)"
OUT=$(post POST "/v1/projects/$P/sessions" '{"title":"Second"}')
S2=$(echo "$OUT" | jget 'd["session"]["id"]')
[ "$(echo "$OUT" | jget 'd["session"]["default"]')" = False ] || fail "a new session became the default"
[ "$(curl -fsS "$BASE/v1/projects/$P/sessions/$S1" | jget 'd["session"]["default"]')" = True ] || fail "the default changed"

echo "== two sessions stream at once (criterion 5)"
curl -fsS -N "$BASE/v1/projects/$P/events" >"$TMP/events.txt" 2>/dev/null & SSE=$!; PIDS+=($SSE)
sleep 0.3
post POST "/v1/projects/$P/messages" '{"text":"[hold:a] first session works"}' >/dev/null
post POST "/v1/projects/$P/sessions/$S2/messages" '{"text":"[hold:b] second session works"}' >/dev/null
waitfor "a held" held a 1 && waitfor "b held" held b 1
is_state "$P" "$S1" working || fail "S1 is $(state "$P" "$S1")"
is_state "$P" "$S2" working || fail "S2 is $(state "$P" "$S2")"
[ "$(curl -fsS "$BASE/v1/projects/$P" | jget 'd["sessions"]["running"]')" = 2 ] || fail "summary does not count two running sessions"
sleep 0.5
python3 - "$TMP/events.txt" "$S1" "$S2" <<'PY' || fail "both sessions' streamed deltas were expected before any release"
import json, sys
typ, seen = None, set()
for line in open(sys.argv[1]):
    line = line.rstrip("\n")
    if line.startswith("event: "):
        typ = line[7:]
    elif line.startswith("data: ") and typ == "message.delta":
        seen.add(json.loads(line[6:]).get("session_id"))
assert sys.argv[2] in seen and sys.argv[3] in seen, seen
PY

echo "== a message to a busy session queues there only (criterion 6)"
OUT=$(post POST "/v1/projects/$P/messages" '{"text":"quick queued in the first"}')
[ "$(echo "$OUT" | jget 'd["waiting_for"]')" = turn ] || fail "queued: $OUT"
[ "$(qlen "$P" "$S1")" = 1 ] && [ "$(qlen "$P" "$S2")" = 0 ] || fail "queues: S1 $(qlen "$P" "$S1") S2 $(qlen "$P" "$S2")"
[ "$(curl -fsS "$BASE/v1/projects/$P/queue" | jget 'd["session_id"]')" = "$S1" ] || fail "GET /queue is not the default's"

echo "== stopping one session leaves the other running"
post POST "/v1/projects/$P/sessions/$S2/stop" >/dev/null
waitfor "S2 stopped" is_state "$P" "$S2" stopped
is_state "$P" "$S1" working || fail "S1 stopped too"
release a
waitfor "S1 ran its queue" sh -c "[ \"\$(curl -fsS -H 'Authorization: Bearer $HARNESS_API_TOKEN' $BASE/v1/projects/$P/sessions/$S1/queue | python3 -c 'import json,sys; print(len(json.load(sys.stdin)[\"messages\"]))')\" = 0 ]"
waitfor "S1 idle" is_state "$P" "$S1" idle
release b

echo "== the project's running cap queues for a slot (criterion 7)"
post PATCH "/v1/projects/$P" '{"session_settings":{"max_running":1}}' >/dev/null
[ "$(curl -fsS "$BASE/v1/projects/$P" | jget 'd["session_settings"]["max_running"]')" = 1 ] || fail "setting not stored"
post POST "/v1/projects/$P/messages" '{"text":"[hold:c] holds the only slot"}' >/dev/null
waitfor "c held" held c 1
OUT=$(post POST "/v1/projects/$P/sessions/$S2/messages" '{"text":"quick waits for a slot"}')
[ "$(echo "$OUT" | jget 'd["waiting_for"]')" = slot ] || fail "slot: $OUT"
is_state "$P" "$S2" queued || fail "S2 is $(state "$P" "$S2"), want queued"
release c
waitfor "S2 ran after the slot freed" sh -c "[ \"\$(curl -fsS -H 'Authorization: Bearer $HARNESS_API_TOKEN' $BASE/v1/projects/$P/sessions/$S2 | python3 -c 'import json,sys; print(json.load(sys.stdin)[\"session\"][\"exchanges\"])')\" = 2 ]"
waitfor "S2 idle" is_state "$P" "$S2" idle
post PATCH "/v1/projects/$P" '{"session_settings":{"max_running":3}}' >/dev/null

echo "== default-session aliases (criterion 9)"
ROOT2=$(curl -fsS "$BASE/v1/projects/$P/sessions/$S2" | jget 'd["session"]["root_agent_id"]')
post POST "/v1/projects/$P/sessions/$S2/default" >/dev/null
[ "$(curl -fsS "$BASE/v1/projects/$P" | jget 'd["orchestrator_agent_id"]')" = "$ROOT2" ] || fail "orchestrator_agent_id is not the new default's root"
MSG=$(post POST "/v1/projects/$P/messages" '{"text":"quick to the new default"}')
[ "$(echo "$MSG" | jget 'd["message"]["session_id"]')" = "$S2" ] || fail "POST /messages did not go to the default: $MSG"
waitfor "S2 idle" is_state "$P" "$S2" idle
post POST "/v1/projects/$P/sessions/$S1/resume" >/dev/null
[ "$(curl -fsS "$BASE/v1/projects/$P/sessions/$S1" | jget 'd["session"]["default"]')" = True ] || fail "/resume is not an alias of /default"
post POST "/v1/projects/$P/sessions/$S2/messages" '{"text":"[hold:f] keeps S2 busy"}' >/dev/null
waitfor "f held" held f 1
post POST "/v1/projects/$P/cancel" >/dev/null
sleep 0.5
is_state "$P" "$S2" working || fail "POST /cancel stopped a session that is not the default"
NEWDEF=$(post POST "/v1/projects/$P/clear" | jget 'd["session_id"]')
[ "$(curl -fsS "$BASE/v1/projects/$P/sessions/$NEWDEF" | jget 'd["session"]["default"]')" = True ] || fail "/clear did not make the new session the default"
is_state "$P" "$S2" working || fail "/clear of the default touched S2"
post POST "/v1/projects/$P/cancel?all=true" >/dev/null
waitfor "S2 stopped by cancel all" is_state "$P" "$S2" stopped
release f
[ "$(code POST "/v1/projects/$P/sessions/$S2/clear")" = 201 ] || fail "POST /sessions/{sid}/clear: $(cat "$TMP/body")"
[ "$(python3 -c "import json; print(json.load(open('$TMP/body'))['session']['default'])")" = False ] || fail "clear of a non-default session made a default"

echo "== GET /v1/sessions lists across projects"
Q=$(newproject beta)
post POST "/v1/projects/$Q/messages" '{"text":"quick in beta"}' >/dev/null
waitfor "beta in the list" sh -c "curl -fsS -H 'Authorization: Bearer $HARNESS_API_TOKEN' '$BASE/v1/sessions?limit=200' | grep -q '\"project_name\":\"beta\"'"
curl -fsS "$BASE/v1/sessions" | python3 -c "
import json,sys
l=json.load(sys.stdin)['sessions']
assert {s['project_id'] for s in l} >= {'$P','$Q'}, l
assert all(s['kind']=='main' for s in l)
assert [s['last_activity_at'] for s in l] == sorted([s['last_activity_at'] for s in l], reverse=True)
" || fail "GET /v1/sessions"

echo "== restart after kill -9 with two running sessions (criterion 12)"
R=$(newproject gamma)
T1=$(curl -fsS "$BASE/v1/projects/$R/sessions?kind=main" | jget '[s["id"] for s in d["sessions"] if s["default"]][0]')
T2=$(post POST "/v1/projects/$R/sessions" '{}' | jget 'd["session"]["id"]')
post POST "/v1/projects/$R/sessions/$T1/messages" '{"text":"[hold:g] first long turn"}' >/dev/null
post POST "/v1/projects/$R/sessions/$T2/messages" '{"text":"[hold:h] second long turn"}' >/dev/null
waitfor "g held" held g 1 && waitfor "h held" held h 1
post POST "/v1/projects/$R/sessions/$T1/messages" '{"text":"quick waiting one"}' >/dev/null
post POST "/v1/projects/$R/sessions/$T2/messages" '{"text":"quick waiting two"}' >/dev/null
kill -9 "$HPID"; wait "$HPID" 2>/dev/null || true; sleep 0.3
release g; release h
start_harness
for T in "$T1" "$T2"; do
  D=$(curl -fsS "$BASE/v1/projects/$R/sessions/$T")
  echo "$D" | python3 -c "
import json,sys
d=json.load(sys.stdin)
ex=d['exchanges']
assert d['session']['state']=='failed', d['session']['state']
assert len(ex)==1 and ex[0]['interrupted'] and ex[0]['status']=='failed', ex
assert d['session']['queued']==1 and d['session']['queue_paused'], d['session']
" || fail "session $T after the restart: $D"
done
[ "$(curl -fsS "$BASE/v1/projects/$R/sessions/$T2/queue" | jget 'd["paused"]')" = True ] || fail "queue of T2 not paused"

echo "OK: parallel sessions e2e passed"
