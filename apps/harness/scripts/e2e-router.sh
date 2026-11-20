#!/usr/bin/env bash
# End-to-end check of the harness against a REAL Octo router (integration I1).
# The harness talks to the router's autoroute path (--base-url .../autoroute), where hints and result headers live.
#   router :8811  ->  mock upstream :8812     harness :8815 (via router), :8816 (direct to the mock),
#   :8817 (via router, delegation.escalate_on_failure on)
# Cases 7 and 8 (delegation records, outcome, export, escalation) need a router with route_outcome.
# Ports: E2E_ROUTER_PORT, E2E_MOCK_PORT, E2E_HARNESS_PORT, E2E_DIRECT_PORT, E2E_ESCALATE_PORT (the values above are the defaults; a busy
# default moves to the next free port, a busy port you set is an error). E2E_WAIT_SECS (default 60) bounds each start-up wait.
# The harnesses run with HARNESS_NO_BUILTIN_PLUGINS=1: no third-party agent CLI is probed or started.
# Needs `cargo build -p octo` (target/debug/octo) and Go. Touches only a temp dir.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
TMP=$(mktemp -d)
PIDS=()
cleanup() { for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null || true; done; rm -rf "$TMP"; }
trap cleanup EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }
source "$ROOT/scripts/lib-ports.sh"
pick_port E2E_ROUTER_PORT 8811; pick_port E2E_MOCK_PORT 8812; pick_port E2E_HARNESS_PORT 8815; pick_port E2E_DIRECT_PORT 8816; pick_port E2E_ESCALATE_PORT 8817
RP=$E2E_ROUTER_PORT MP=$E2E_MOCK_PORT HP=$E2E_HARNESS_PORT DP=$E2E_DIRECT_PORT EP=$E2E_ESCALATE_PORT
WAIT=${E2E_WAIT_SECS:-60}

# The harness requires a bridge API token on /v1: every harness started below gets this one, every curl sends it
# (except to the router, which would forward it upstream). The check itself is exercised by the 401 test further down.
export HARNESS_API_TOKEN="e2e-token-$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
curl() {
  case "$*" in
    *127.0.0.1:$RP*|*127.0.0.1:$MP*) command curl --max-time 30 "$@" ;;
    *) command curl --max-time 30 -H "Authorization: Bearer $HARNESS_API_TOKEN" "$@" ;;
  esac
}
jget() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)"; }

(cd "$ROOT/apps/harness" && go build -o "$TMP/harness" ./cmd/harness && go build -o "$TMP/mockllm" ./examples/mockllm)

# Router config: ports, mock upstream, a throwaway history db, ruinous prices so $0.01 is one request.
cp -r "$ROOT/apps/router/config" "$TMP/config"
sed -i "s|^bind_addr = .*|bind_addr = \"127.0.0.1:$RP\"|" "$TMP/config/server.toml"
sed -i "s|^messages_url = .*|messages_url = \"http://127.0.0.1:$MP/v1/messages\"|; s|^decisions_url = .*|decisions_url = \"http://127.0.0.1:$MP/decisions\"|" "$TMP/config/openrouter.toml"
sed -i "s|^database_path = .*|database_path = \"$TMP/history.sqlite\"|" "$TMP/config/history.toml"
: > "$TMP/config/prices.toml"
for slug in deepseek/deepseek-v4.1-flash minimax/minimax-m3.1-flash deepseek/deepseek-v4.1-flash-1017; do
  printf '[prices."%s"]\ninput = 5000.0\ncache_read = 500.0\ncache_write = 6000.0\noutput = 25000.0\n' "$slug" >> "$TMP/config/prices.toml"
done

"$TMP/mockllm" --addr 127.0.0.1:$MP --delay 1ms >"$TMP/mock.log" 2>&1 & PIDS+=($!)
(cd "$TMP" && exec env OCTO_CONFIG="$TMP/config" "$ROOT/target/debug/octo" >"$TMP/router.log" 2>&1) & PIDS+=($!)
wait_http "http://127.0.0.1:$RP/health" "$WAIT" || true
curl -fsS http://127.0.0.1:$RP/health | grep -q '"service":"octo"' || fail "router not up: $(cat "$TMP/router.log")"
# Harnesses start after the router: detection happens at start-up (a late router is found by the minute re-probe).
HARNESS_DEFAULT_ACCESS=full HARNESS_NO_BUILTIN_PLUGINS=1 ANTHROPIC_API_KEY=mock "$TMP/harness" serve --addr 127.0.0.1:$HP --data-dir "$TMP/h1" --base-url http://127.0.0.1:$RP/autoroute >"$TMP/h1.log" 2>&1 & PIDS+=($!)
# The third harness has delegation.escalate_on_failure = once (case 8).
HARNESS_DELEGATION_ESCALATE_ON_FAILURE=1 HARNESS_DEFAULT_ACCESS=full HARNESS_NO_BUILTIN_PLUGINS=1 ANTHROPIC_API_KEY=mock "$TMP/harness" serve --addr 127.0.0.1:$EP --data-dir "$TMP/h3" --base-url http://127.0.0.1:$RP/autoroute >"$TMP/h3.log" 2>&1 & PIDS+=($!)
HARNESS_DEFAULT_ACCESS=full HARNESS_NO_BUILTIN_PLUGINS=1 ANTHROPIC_API_KEY=mock "$TMP/harness" serve --addr 127.0.0.1:$DP --data-dir "$TMP/h2" --base-url http://127.0.0.1:$MP >"$TMP/h2.log" 2>&1 & PIDS+=($!)
for url in http://127.0.0.1:$HP/health http://127.0.0.1:$DP/health http://127.0.0.1:$EP/health; do
  wait_http "$url" "$WAIT" || fail "harness at $url did not answer within ${WAIT}s: $(tail -n 5 "$TMP"/h*.log)"
done

new_project() { # $1 bridge, $2 extra json
  mkdir -p "$TMP/ws"
  curl -fsS -X POST "$1/v1/projects" -H 'content-type: application/json' \
    -d "{\"name\":\"e2e\",\"max_depth\":1,\"folders\":[{\"path\":\"$TMP/ws\"}]$2}" | jget 'd["id"]'
}
run_turn() { # $1 bridge, $2 project, $3 text -> prints turn status
  local before after
  curl -fsS -X POST "$1/v1/projects/$2/messages" -H 'content-type: application/json' -d "{\"text\":\"$3\"}" >/dev/null
  local end=$((SECONDS + ${E2E_WAIT_SECS:-60} * 2)) st=""
  while [ $SECONDS -lt $end ]; do
    sleep 0.2
    st=$(curl -fsS "$1/v1/projects/$2" | jget 'd["status"]')
    [ "$st" = idle ] && break
  done
  [ "$st" = idle ] || fail "project $2 on $1 did not go idle (status: $st)"
  curl -fsS "$1/v1/projects/$2/agents" | jget '[a for a in d["agents"] if a["parent_id"] is None][0]["error"] or "ok"'
}

echo "== config"
[ "$(command curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:$HP/v1/config)" = 401 ] || fail "harness $HP answered /v1/config without the API token"
[ "$(command curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:$HP/health)" = 200 ] || fail "harness $HP /health is not open"
curl -fsS http://127.0.0.1:$HP/v1/config | jget 'd["router"], d["router_capabilities"]' | grep -q "True" || fail "harness $HP did not detect the router"
curl -fsS http://127.0.0.1:$DP/v1/config | jget 'd["router"]' | grep -q "False" || fail "harness $DP detected a router at the mock"

echo "== (1) three sub-agents, one budget key, served model / tier / trigger / router cost in /v1/usage"
P1=$(new_project http://127.0.0.1:$HP "")
res=$(run_turn http://127.0.0.1:$HP "$P1" "build it")
[ "$res" = ok ] || fail "turn 1 error: $res"
curl -fsS "http://127.0.0.1:$HP/v1/usage?group=model&project=$P1" | tee "$TMP/usage.json" | \
  jget 'sorted(b["key"] for b in d["buckets"])' ; 
python3 - "$TMP/usage.json" <<'PY' || fail "usage buckets are not served ladder models with reported costs"
import json, sys
d = json.load(open(sys.argv[1]))
slugs = {"deepseek/deepseek-v4.1-flash", "minimax/minimax-m3.1-flash", "deepseek/deepseek-v4.1-flash-1017"}
assert d["buckets"] and all(b["key"] in slugs for b in d["buckets"]), d["buckets"]
assert d["total"]["cost_usd"] and d["total"]["cost_usd"] > 0, d["total"]
print("requests:", d["total"]["requests"], "cost:", d["total"]["cost_usd"], "estimated:", d["total"]["cost_estimated"])
PY

echo "== (2) a \$0.01 budget stops the turn"
P2=$(new_project http://127.0.0.1:$HP ',"budget_usd":0.01')
n_before=$(curl -fsS "http://127.0.0.1:$HP/v1/usage?group=day&project=$P2" | jget 'd["total"]["requests"]')
res=$(run_turn http://127.0.0.1:$HP "$P2" "build it")
echo "orchestrator error: $res"
echo "$res" | grep -Eq '^This project.s budget is used up \(\$[0-9.]+ of \$0\.01\)\.$' || fail "no budget message"
sleep 1
n1=$(curl -fsS "http://127.0.0.1:$HP/v1/usage?group=day&project=$P2" | jget 'd["total"]["requests"]')
sleep 1
n2=$(curl -fsS "http://127.0.0.1:$HP/v1/usage?group=day&project=$P2" | jget 'd["total"]["requests"]')
[ "$n1" = "$n2" ] || fail "requests kept coming after the turn stopped ($n1 -> $n2)"
curl -fsS "http://127.0.0.1:$HP/v1/projects/$P2" | jget 'd["budget_usd"], d["spent_usd"]'

echo "== (6) tier auto: the router chooses who does the task (integration I2)"
if curl -fsS http://127.0.0.1:$RP/health | grep -q '"route_api"'; then
  curl -fsS http://127.0.0.1:$HP/v1/config | jget 'd["route_api"]' | grep -q True || fail "harness $HP does not report route_api"
  P4=$(new_project http://127.0.0.1:$HP "")
  res=$(run_turn http://127.0.0.1:$HP "$P4" "[auto] find the bug")
  [ "$res" = ok ] || fail "auto turn error: $res"
  curl -fsS "http://127.0.0.1:$HP/v1/projects/$P4/agents" > "$TMP/agents4.json"
  RID=$(jget '[a for a in d["agents"] if a["parent_id"]][0]["route_request_id"] or ""' < "$TMP/agents4.json")
  [ -n "$RID" ] || fail "sub-agent has no route_request_id: $(cat "$TMP/agents4.json")"
  curl -fsS "http://127.0.0.1:$RP/autoroute/v1/calls/$RID" > "$TMP/route-call.json" || fail "no call record for $RID"
  python3 - "$TMP/agents4.json" "$TMP/route-call.json" <<'PY' || fail "route decision not recorded consistently"
import json, sys
a = [x for x in json.load(open(sys.argv[1]))["agents"] if x["parent_id"]][0]
c = json.load(open(sys.argv[2]))
assert a["route_choice"] in ("fast", "balanced", "deep"), a["route_choice"]  # no ACP agent is configured here
assert a["route_reason"], a
assert a["route_band"] in ("easy", "medium", "hard"), a["route_band"]
assert c["trigger"] == "route" and c["route"]["choice"] == a["route_choice"], c
# The mock upstream cannot classify, so the router used its text rule (reason says "classifier not used").
print("choice:", a["route_choice"], "band:", a["route_band"], "reason:", a["route_reason"])
print("classifier:", c["route"]["classifier"])
PY

  echo "== (7) the delegation leaves a record, its outcome arrives, the export has the line with a label"
  out=""
  for _ in $(seq 1 50); do
    out=$(curl -fsS "http://127.0.0.1:$RP/autoroute/v1/route/$RID/outcome" || true)
    echo "$out" | grep -q '"event":"finished"' && break
    sleep 0.2
  done
  echo "$out" > "$TMP/outcome.json"
  python3 - "$TMP/outcome.json" <<'PY' || fail "no finished outcome on the delegation record: $(cat "$TMP/outcome.json")"
import json, sys
o = json.load(open(sys.argv[1]))
fin = [r["body"] for r in o["reports"] if r["event"] == "finished"]
assert fin and fin[0]["status"] == "completed" and fin[0]["usage"]["turns"] >= 1, o
assert o["solved"] in ("yes", "no", "unknown") and o["rule"], o
print("outcome:", fin[0]["status"], fin[0]["agent_signal"], "turns", fin[0]["usage"]["turns"], "->", o["solved"], o["rule"], o["confidence"])
PY
  "$ROOT/target/debug/octo" export-delegations --db "$TMP/history.sqlite" --out "$TMP/delegations.jsonl" 2>&1
  "$ROOT/target/debug/octo" export-delegations --db "$TMP/history.sqlite" --out "$TMP/redacted.jsonl" --redact 2>&1
  python3 - "$TMP/delegations.jsonl" "$TMP/redacted.jsonl" "$RID" <<'PY' || fail "export does not hold the labelled delegation"
import json, sys
lines = [json.loads(l) for l in open(sys.argv[1])]
line = [l for l in lines if l["request_id"] == sys.argv[3]][0]
assert line["schema"] == "octo.delegation.v1" and line["label"]["solved"] in ("yes", "no"), line["label"]
assert line["task"]["brief"] and line["outcome"]["status"] == "completed", line
red = [json.loads(l) for l in open(sys.argv[2])]
assert all(l["task"]["brief"] is None and l["task"]["title"] is None for l in red)
print("export:", len(lines), "lines; label", line["label"], "classifier", line["decision"]["classifier"])
PY

  echo "== (8) a cheap attempt that fails is retried once on a stronger candidate"
  # The mock answers "Could not do it" for a sub-agent served by the mid ladder model; the router's text rule rates this
  # brief medium (balanced), so the retry must be excluded from balanced and floored at deep.
  P5=$(new_project http://127.0.0.1:$EP "")
  res=$(run_turn http://127.0.0.1:$EP "$P5" "[auto] [fail-model:minimax/minimax-m3.1-flash] fix it")
  [ "$res" = ok ] || fail "escalation turn error: $res"
  curl -fsS "http://127.0.0.1:$EP/v1/projects/$P5/agents" > "$TMP/agents5.json"
  python3 - "$TMP/agents5.json" > "$TMP/esc-ids" <<'PY' || fail "no single escalation: $(cat "$TMP/agents5.json")"
import json, sys
kids = sorted([a for a in json.load(open(sys.argv[1]))["agents"] if a["parent_id"]], key=lambda a: a["created_at"])
assert len(kids) == 2, [(k["route_choice"], k["route_reason"]) for k in kids]
first, second = kids
assert first["route_choice"] == "balanced" and second["route_choice"] == "deep", (first["route_choice"], second["route_choice"])
assert second["route_reason"].startswith("Retried on the deep tier after it reported it could not do the task."), second["route_reason"]
print(first["route_request_id"], second["route_request_id"])
print("retry:", second["route_reason"], file=sys.stderr)
PY
  read -r FIRST SECOND < "$TMP/esc-ids"
  for _ in $(seq 1 50); do
    curl -fsS "http://127.0.0.1:$RP/autoroute/v1/route/$FIRST/outcome" > "$TMP/esc1.json" || true
    grep -q '"event":"escalated"' "$TMP/esc1.json" && break
    sleep 0.2
  done
  curl -fsS "http://127.0.0.1:$RP/autoroute/v1/route/$SECOND/outcome" > "$TMP/esc2.json"
  python3 - "$TMP/esc1.json" "$TMP/esc2.json" "$SECOND" <<'PY' || fail "escalation records are not linked"
import json, sys
a, b = json.load(open(sys.argv[1])), json.load(open(sys.argv[2]))
esc = [r["body"] for r in a["reports"] if r["event"] == "escalated"]
assert esc and esc[0]["by"] == sys.argv[3] and esc[0]["reason"] == "could_not", a
assert a["solved"] == "no" and a["rule"] in ("could_not", "escalated"), a
assert b["attempt"] == 2 and b["escalated_from"] == a["request_id"], b
print("attempt 1:", a["choice"], a["solved"], a["rule"], "| attempt 2:", b["choice"], "escalated_from", b["escalated_from"])
PY
else
  echo "SKIPPED: the router does not advertise route_api (build a router with the route endpoint to run this case)"
fi

echo "== (5) non-Octo base URL: nothing changes"
P3=$(new_project http://127.0.0.1:$DP "")
res=$(run_turn http://127.0.0.1:$DP "$P3" "build it")
[ "$res" = ok ] || fail "direct turn error: $res"
curl -fsS "http://127.0.0.1:$DP/v1/usage?group=model&project=$P3" | jget '[b["key"] for b in d["buckets"]]' | grep -q "claude" || fail "direct run should be keyed by the requested models"
echo "OK"
