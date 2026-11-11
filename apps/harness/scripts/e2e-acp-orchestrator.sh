#!/usr/bin/env bash
# End-to-end check of an ACP-run orchestrator: a real `harness serve` with the scripted ACP agent
# (examples/fakeacp) as a project's orchestrator, driven only through the bridge with curl.
#   scenario 1 (:8821): agent without HTTP MCP  -> the harness binary itself is the stdio relay (`harness mcp-relay`)
#   scenario 2 (:8822): agent with HTTP MCP and loadSession -> HTTP entry, session/load after a crash
# Needs Go and python3. Touches only a temp dir. No model, no network, no third-party agent CLI.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
TMP=$(mktemp -d)
PIDS=()
cleanup() { for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null || true; done; sleep 0.3; rm -rf "$TMP"; }
trap cleanup EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }
jget() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)"; }

(cd "$ROOT/apps/harness" && go build -o "$TMP/harness" ./cmd/harness && go build -o "$TMP/fakeacp" ./examples/fakeacp \
  && go build -o "$TMP/mockllm" ./examples/mockllm)
"$TMP/mockllm" --addr 127.0.0.1:8820 --delay 1ms >"$TMP/mock.log" 2>&1 & PIDS+=($!)

plugin() { # $1 dir, $2 extra env json members (may be empty)
  mkdir -p "$1/fake"
  cat >"$1/fake/plugin.json" <<JSON
{"name":"fake","version":"1","agents":[{"id":"scripted","label":"Scripted","command":"$TMP/fakeacp",
 "env":{"OCTO_FAKEACP_UNIQUE_SESSIONS":"1"$2}}]}
JSON
}
serve() { # $1 port, $2 data dir, $3 plugins dir; env HARNESS_ACP_IDLE optional
  ANTHROPIC_API_KEY=mock "$TMP/harness" serve --addr "127.0.0.1:$1" --data-dir "$2" --base-url http://127.0.0.1:8820 \
    --plugins-dir "$3" >"$2.log" 2>&1 & PIDS+=($!)
  SERVE_PID=$!
  for _ in $(seq 60); do curl -fsS "http://127.0.0.1:$1/health" >/dev/null 2>&1 && return; sleep 0.2; done
  fail "harness on :$1 did not start: $(cat "$2.log")"
}
ask() { # $1 bridge, $2 project, $3 text -> waits for the turn to end, prints the orchestrator's text of that turn
  curl -fsS -X POST "$1/v1/projects/$2/messages" -H 'content-type: application/json' -d "{\"text\":\"$3\"}" >/dev/null
  sleep 0.3
  for _ in $(seq 100); do
    [ "$(curl -fsS "$1/v1/projects/$2" | jget 'd["status"]')" = idle ] && break
    sleep 0.2
  done
  curl -fsS "$1/v1/projects/$2/agents/$ORCH/messages" | jget '
" ".join(c.get("text","") for m in d["messages"][max(i for i,m in enumerate(d["messages"]) if m["role"]=="user" and m["content"] and m["content"][0]["type"]=="text"):] if m["role"]=="assistant" for c in m["content"] if c["type"]=="text")'
}
field() { grep -oE "$1=[^ ]+" <<<"$2" | head -1 | cut -d= -f2; }
gone() { # pid -> waits for it to be gone (a zombie counts as gone)
  for _ in $(seq 100); do
    [ -r "/proc/$1/stat" ] || return 0
    [ "$(sed -E 's/.*\) (.).*/\1/' "/proc/$1/stat")" = Z ] && return 0
    sleep 0.1
  done
  return 1
}

scenario() { # $1 name, $2 port, $3 extra agent env, $4 expected transport, $5 expects loaded after a crash
  local name=$1 port=$2 base="http://127.0.0.1:$2"
  echo "== scenario $name"
  mkdir -p "$TMP/$name-ws" && printf '# E2E workspace\n' >"$TMP/$name-ws/README.md"
  plugin "$TMP/$name-plugins" "$3"
  serve "$port" "$TMP/$name-data" "$TMP/$name-plugins"
  local serve_pid=$SERVE_PID

  curl -fsS "$base/v1/config" | jget '[o["value"] for o in d["acp_orchestrators"]]' | grep -q "acp:scripted" || fail "/v1/config does not list acp:scripted"
  code=$(curl -s -o "$TMP/bad.json" -w '%{http_code}' -X POST "$base/v1/projects" -H 'content-type: application/json' \
    -d '{"name":"x","models":{"orchestrator":"acp:nope"}}')
  [ "$code" = 400 ] && grep -q 'unknown ACP agent' "$TMP/bad.json" || fail "unknown acp agent was not rejected with 400 ($code): $(cat "$TMP/bad.json")"

  PID=$(curl -fsS -X POST "$base/v1/projects" -H 'content-type: application/json' \
    -d "{\"name\":\"e2e\",\"max_depth\":2,\"folders\":[{\"path\":\"$TMP/$name-ws\"}],\"models\":{\"orchestrator\":\"acp:scripted\"}}" | jget 'd["id"]')
  ORCH=$(curl -fsS "$base/v1/projects/$PID" | jget 'd["orchestrator_agent_id"]')

  echo "-- request 1: streamed text, MCP spawn_agent and save_note"
  t1=$(ask "$base" "$PID" "[mcp-spawn] look around")
  echo "$t1"
  grep -q "mcp=$4" <<<"$t1" || fail "wrong MCP transport (want $4): $t1"
  grep -q "Sub-agent report: Summary: README.md" <<<"$t1" || fail "the sub-agent report did not come back as the tool result"
  curl -fsS "$base/v1/projects/$PID/agents" | python3 -c '
import json, sys
d = json.load(sys.stdin)
subs = [a for a in d["agents"] if a["parent_id"]]
assert len(subs) == 1 and subs[0]["status"] == "completed" and subs[0]["model"] == "acp:scripted", subs
orch = [a for a in d["agents"] if not a["parent_id"]][0]
assert orch["model"] == "acp:scripted" and orch["error"] is None, orch
' || fail "agents list does not show the sub-agent / orchestrator model"
  curl -fsS "$base/v1/projects/$PID/notes" | grep -q '"mcp-note"' || fail "the note written through MCP is not in the notes API"
  pid1=$(field pid "$t1"); sess1=$(field session "$t1"); relay1=$(field relay "$t1")

  echo "-- request 2: same process, same session"
  t2=$(ask "$base" "$PID" "[echo] again")
  [ "$(field pid "$t2")" = "$pid1" ] && [ "$(field session "$t2")" = "$sess1" ] || fail "second request did not reuse process and session: $t2"

  echo "-- request 3: after kill -9 the next request recovers"
  kill -9 "$pid1"; gone "$pid1" || fail "killed agent still there"
  t3=$(ask "$base" "$PID" "[echo] third")
  pid3=$(field pid "$t3")
  [ "$pid3" != "$pid1" ] || fail "agent was not restarted: $t3"
  if [ "$5" = yes ]; then
    [ "$(field session "$t3")" = "$sess1" ] && grep -q 'loaded=true' <<<"$t3" || fail "session/load was not used: $t3"
  else
    [ "$(field session "$t3")" != "$sess1" ] && grep -q 'Earlier in this conversation' <<<"$t3" || fail "no new session with a recap: $t3"
  fi

  echo "-- project delete leaves no process behind"
  curl -fsS -X DELETE "$base/v1/projects/$PID" -o /dev/null
  gone "$pid3" || fail "agent $pid3 survived project delete"
  if [ "${relay1:-0}" != 0 ]; then gone "$relay1" || fail "relay $relay1 survived"; fi

  echo "-- shutdown leaves no process behind"
  PID=$(curl -fsS -X POST "$base/v1/projects" -H 'content-type: application/json' \
    -d "{\"name\":\"e2e2\",\"folders\":[{\"path\":\"$TMP/$name-ws\"}],\"models\":{\"orchestrator\":\"acp:scripted\"}}" | jget 'd["id"]')
  ORCH=$(curl -fsS "$base/v1/projects/$PID" | jget 'd["orchestrator_agent_id"]')
  t4=$(ask "$base" "$PID" "[mcp-spawn] again")
  pid4=$(field pid "$t4"); relay4=$(field relay "$t4")
  kill -TERM "$serve_pid"
  for _ in $(seq 100); do kill -0 "$serve_pid" 2>/dev/null || break; sleep 0.1; done
  gone "$pid4" || fail "agent $pid4 survived harness shutdown"
  if [ "${relay4:-0}" != 0 ]; then gone "$relay4" || fail "relay $relay4 survived shutdown"; fi
  ! pgrep -f "$TMP/fakeacp" >/dev/null || fail "fakeacp processes remain"
}

scenario stdio 8821 "" stdio no
scenario http 8822 ',"OCTO_FAKEACP_MCP_HTTP":"1","OCTO_FAKEACP_LOAD_SESSION":"1"' http yes
echo "OK: ACP orchestrator e2e passed"
