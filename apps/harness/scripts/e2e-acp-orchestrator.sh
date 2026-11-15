#!/usr/bin/env bash
# End-to-end check of an ACP-run orchestrator: a real `harness serve` with the scripted ACP agent
# (examples/fakeacp) as a project's orchestrator, driven only through the bridge with curl.
#   scenario 1 (:8821): agent without HTTP MCP  -> the harness binary itself is the stdio relay (`harness mcp-relay`)
#   scenario 2 (:8822): agent with HTTP MCP and loadSession -> HTTP entry, session/load after a crash
#   scenario 3 (:8823): no API key at all (see `nokey` below)
#   scenario 4 (:8824): the built-in Antigravity entry with a fake `agy` on PATH (see `agy` below)
# Needs Go and python3. Touches only a temp dir. No model, no network, no third-party agent CLI.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
TMP=$(mktemp -d)
PIDS=()
cleanup() { for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null || true; done; sleep 0.3; rm -rf "$TMP"; }
trap cleanup EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }

# The harness requires a bridge API token on /v1: every harness started below gets this one, every curl sends it
# (except to the router, which would forward it upstream). The check itself is exercised by the 401 test further down.
export HARNESS_API_TOKEN="e2e-token-$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
curl() {
  case "$*" in
    *127.0.0.1:8811*|*127.0.0.1:8812*) command curl "$@" ;;
    *) command curl -H "Authorization: Bearer $HARNESS_API_TOKEN" "$@" ;;
  esac
}
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
  HARNESS_DEFAULT_ACCESS=full HARNESS_NO_BUILTIN_PLUGINS=1 ANTHROPIC_API_KEY=mock "$TMP/harness" serve --addr "127.0.0.1:$1" --data-dir "$2" --base-url http://127.0.0.1:8820 \
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

  [ "$(command curl -s -o /dev/null -w '%{http_code}' "$base/v1/config")" = 401 ] || fail "/v1/config answered without the API token"
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

# scenario 3 (:8823): no key anywhere. ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL and HARNESS_OCTO_KEY are unset, there is no
# upstream to call (mockllm is not passed), PATH holds no agent CLI (so no login probe runs), and {data-dir}/harness.env
# supplies a setting. `harness serve` must start, list the built-in agents, report the built-in loop unavailable, run
# the ACP orchestrator (chosen as the default, nobody named it) and fail built-in work with the one message.
nokey() {
  local name=nokey port=8823 base=http://127.0.0.1:8823 msg
  msg="No API key is configured for the built-in agent loop. Set ANTHROPIC_API_KEY (or a router), or choose an ACP agent for this project."
  echo "== scenario $name"
  mkdir -p "$TMP/$name-ws" "$TMP/$name-data" "$TMP/$name-bin" && printf '# E2E workspace\n' >"$TMP/$name-ws/README.md"
  plugin "$TMP/$name-plugins" ""
  printf 'HARNESS_MODEL_FAST=env-file-fast\nHARNESS_MODEL_BALANCED=env-file-balanced\n' >"$TMP/$name-data/harness.env"
  chmod 600 "$TMP/$name-data/harness.env"
  env -u ANTHROPIC_API_KEY -u ANTHROPIC_BASE_URL -u HARNESS_OCTO_KEY -u HARNESS_PLUGINS_DIR -u HARNESS_DATA_DIR \
    PATH="$TMP/$name-bin" HARNESS_DEFAULT_ACCESS=full HARNESS_MODEL_BALANCED=from-process \
    "$TMP/harness" serve --addr "127.0.0.1:$port" --data-dir "$TMP/$name-data" --plugins-dir "$TMP/$name-plugins" >"$TMP/$name-data.log" 2>&1 & PIDS+=($!)
  local serve_pid=$!
  for _ in $(seq 60); do curl -fsS "$base/health" >/dev/null 2>&1 && break; sleep 0.2; done
  curl -fsS "$base/health" >/dev/null 2>&1 || fail "harness without a key did not start: $(cat "$TMP/$name-data.log")"

  cfg=$(curl -fsS "$base/v1/config")
  [ "$(jget 'd["builtin_loop"]["available"]' <<<"$cfg")" = False ] || fail "builtin_loop.available is not false: $cfg"
  [ "$(jget 'd["builtin_loop"]["reason"]' <<<"$cfg")" = "$msg" ] || fail "builtin_loop.reason differs: $cfg"
  [ "$(jget 'd["default_orchestrator"]' <<<"$cfg")" = "acp:scripted" ] || fail "default_orchestrator is not acp:scripted: $cfg"
  [ "$(jget 'd["default_models"]["fast"]' <<<"$cfg")" = env-file-fast ] || fail "harness.env was not read: $cfg"
  [ "$(jget 'd["default_models"]["balanced"]' <<<"$cfg")" = from-process ] || fail "the process environment must win over harness.env: $cfg"
  curl -fsS "$base/v1/plugins" | python3 -c '
import json, sys
d = json.load(sys.stdin)
b = [p for p in d["plugins"] if p["name"] == "subscription-agents"]
assert len(b) == 1 and b[0]["builtin"] is True and not b[0]["errors"] and len(b[0]["agents"]) >= 10, d
' || fail "/v1/plugins does not list the built-in subscription agents"

  echo "-- turn on the default orchestrator (no key, no explicit choice)"
  PID=$(curl -fsS -X POST "$base/v1/projects" -H 'content-type: application/json' \
    -d "{\"name\":\"nokey\",\"folders\":[{\"path\":\"$TMP/$name-ws\"}]}" | jget 'd["id"]')
  ORCH=$(curl -fsS "$base/v1/projects/$PID" | jget 'd["orchestrator_agent_id"]')
  t1=$(ask "$base" "$PID" "[echo] no key needed")
  echo "$t1"
  grep -q "no key needed" <<<"$t1" || fail "the ACP orchestrator did not answer without a key: $t1"
  curl -fsS "$base/v1/projects/$PID/agents" | python3 -c '
import json, sys
d = json.load(sys.stdin)
orch = [a for a in d["agents"] if not a["parent_id"]][0]
assert orch["model"] == "acp:scripted" and orch["status"] == "idle" and orch["error"] is None, orch
' || fail "the orchestrator did not run on acp:scripted"

  echo "-- live activity: thinking, plan, activity line and a tool row that appears before it ends"
  curl -sN "$base/v1/projects/$PID/events" >"$TMP/$name-sse.txt" 2>/dev/null & SSE_PID=$!
  sleep 0.3
  ask "$base" "$PID" "[live] go" >/dev/null
  sleep 0.3; kill "$SSE_PID" 2>/dev/null || true
  python3 - "$TMP/$name-sse.txt" <<'PY' || fail "live activity events missing or out of order"
import json, sys
evs = []
etype = None
for line in open(sys.argv[1], encoding="utf-8"):
    line = line.rstrip("\n")
    if line.startswith("event: "):
        etype = line[7:]
    elif line.startswith("data: ") and etype:
        evs.append((etype, json.loads(line[6:])))
        etype = None
types = [t for t, _ in evs]
def first(t, pred=lambda d: True):
    return next(i for i, (x, d) in enumerate(evs) if x == t and pred(d))
assert "message.thinking_delta" in types, "no thinking_delta"
plans = [d for t, d in evs if t == "agent.plan"]
assert len(plans) == 2 and plans[-1]["entries"][0]["status"] == "completed", plans
acts = [(d["kind"], d["label"]) for t, d in evs if t == "agent.activity"]
assert ("tool", "Reading README.md") in acts and ("text", "Writing") in acts and acts[-1][0] == "idle", acts
row = first("message.created", lambda d: "call-live" in json.dumps(d["message"]["content"]))
done = first("tool.finished", lambda d: d["tool_use_id"] == "call-live")
assert row < done, (row, done)
assert any(t == "tool.updated" and d.get("title") == "Read README.md" for t, d in evs), "no tool.updated"
PY
  echo "-- a project on a built-in model is refused while nothing can run it; a new project runs its tiers on the one ready agent"
  code=$(curl -sS -o "$TMP/$name-422.json" -w '%{http_code}' -X POST "$base/v1/projects" -H 'content-type: application/json' \
    -d "{\"name\":\"builtin\",\"folders\":[{\"path\":\"$TMP/$name-ws\"}],\"models\":{\"orchestrator\":\"claude-opus-5-5\"}}")
  [ "$code" = 422 ] || fail "creating a project on an unusable model answered $code, want 422"
  [ "$(jget 'd["error"]["code"]+"/"+d["error"]["provider"]' <"$TMP/$name-422.json")" = model_unavailable/api ] || fail "422 body: $(cat "$TMP/$name-422.json")"
  [ "$(curl -fsS "$base/v1/providers" | jget 'd["suggested"]["orchestrator"]')" = acp:scripted ] || fail "suggested is not the one ready agent"
  t2=$(ask "$base" "$PID" "[mcp-spawn-builtin] spawn without agent")
  # the project got the suggested models (acp:scripted in every slot), so a tier-based spawn runs on the agent
  grep -q "Sub-agent report" <<<"$t2" && ! grep -qF "$msg" <<<"$t2" || fail "a tier-based sub-agent did not run on the ready agent: $t2"
  ! grep -qi "upstream\|connection refused" "$TMP/$name-data.log" || fail "the harness tried to reach an upstream: $(grep -i 'upstream\|connection refused' "$TMP/$name-data.log")"

  kill -TERM "$serve_pid"
  for _ in $(seq 100); do kill -0 "$serve_pid" 2>/dev/null || break; sleep 0.1; done
  ! kill -0 "$serve_pid" 2>/dev/null || fail "harness did not stop"
  ! pgrep -f "$TMP/fakeacp" >/dev/null || fail "fakeacp processes remain"
}

# scenario 4 (:8824): the built-in `antigravity` entry, unchanged, with a fake `agy` (the scripted agent's agy profile,
# written from Google's documentation) as the only CLI on PATH. Built-in plugins are on here on purpose: PATH has no
# npx, claude or other agent CLI, so nothing else can start. Signed out -> "Antigravity is not logged in." with
# `agy acp --login`; `agy acp --login` -> the next request works, with the tool server over the stdio relay although
# agy advertises HTTP MCP; an agy older than 1.5.0 -> after "Check again" the provider says it is too old, with the installer line.
agy() {
  local name=agy port=8824 base=http://127.0.0.1:8824
  echo "== scenario $name"
  mkdir -p "$TMP/$name-ws" "$TMP/$name-data" "$TMP/$name-bin" && printf '# E2E workspace\n' >"$TMP/$name-ws/README.md"
  mkfake() { # $1 version
    printf '#!/bin/sh\nOCTO_FAKEACP_PROFILE=agy OCTO_FAKEACP_AGY_VERSION=%s OCTO_FAKEACP_UNIQUE_SESSIONS=1 OCTO_FAKEACP_LOGIN_FILE=%s exec %s "$@"\n' \
      "$1" "$TMP/$name-login" "$TMP/fakeacp" >"$TMP/$name-bin/agy"
    chmod +x "$TMP/$name-bin/agy"
  }
  mkfake 1.5.9
  env -u HARNESS_NO_BUILTIN_PLUGINS -u HARNESS_PLUGINS_DIR -u GEMINI_API_KEY PATH="$TMP/$name-bin" HOME="$TMP/$name-data" \
    HARNESS_DEFAULT_ACCESS=full HARNESS_MODEL_DISCOVERY=0 ANTHROPIC_API_KEY=mock \
    "$TMP/harness" serve --addr "127.0.0.1:$port" --data-dir "$TMP/$name-data" --base-url http://127.0.0.1:8820 >"$TMP/$name-data.log" 2>&1 & PIDS+=($!)
  local serve_pid=$!
  for _ in $(seq 60); do curl -fsS "$base/health" >/dev/null 2>&1 && break; sleep 0.2; done
  curl -fsS "$base/health" >/dev/null 2>&1 || fail "harness with fake agy did not start: $(cat "$TMP/$name-data.log")"
  curl -fsS "$base/v1/providers" | python3 -c '
import json, sys
p = [x for x in json.load(sys.stdin)["providers"] if x["id"] == "antigravity"][0]
assert p["state"] == "ready" and p["experimental"] is True, p
' || fail "antigravity is not listed ready and experimental"

  echo "-- signed out: one plain notice with the login command"
  PID=$(curl -fsS -X POST "$base/v1/projects" -H 'content-type: application/json' \
    -d "{\"name\":\"agy\",\"folders\":[{\"path\":\"$TMP/$name-ws\"}],\"models\":{\"orchestrator\":\"acp:antigravity\"}}" | jget 'd["id"]')
  ORCH=$(curl -fsS "$base/v1/projects/$PID" | jget 'd["orchestrator_agent_id"]')
  ask "$base" "$PID" "hello" >/dev/null
  curl -fsS "$base/v1/projects/$PID/agents" | python3 -c '
import json, sys
o = [a for a in json.load(sys.stdin)["agents"] if not a["parent_id"]][0]
assert o["error"] == "Antigravity is not logged in.", o
' || fail "signed-out agy was not reported as not logged in"

  echo "-- agy acp --login, then the request works with the stdio relay"
  "$TMP/$name-bin/agy" acp --login >/dev/null
  t1=$(ask "$base" "$PID" "[mcp-info] which tools")
  echo "$t1"
  grep -q "mcp-info: transport=stdio" <<<"$t1" || fail "agy did not get the stdio relay: $t1"

  echo "-- an agy older than 1.5.0 is too old after Check again"
  mkfake 1.4.12
  curl -fsS -X POST "$base/v1/providers/antigravity/recheck" | python3 -c '
import json, sys
d = json.load(sys.stdin)
p = d.get("provider", d)
pr = p["problem"]
assert p["state"] == "not_installed" and pr["message"] == "Antigravity 1.4.12 is too old for Octo; it needs 1.5.0 or newer." \
  and pr["command"] == "curl -fsSL https://antigravity.google/cli/install.sh | bash" and pr["action"] == "recheck_provider", p
' || fail "an old agy was not reported as too old"

  kill -TERM "$serve_pid"
  for _ in $(seq 100); do kill -0 "$serve_pid" 2>/dev/null || break; sleep 0.1; done
  ! pgrep -f "$TMP/fakeacp" >/dev/null || fail "fakeacp processes remain"
}

scenario stdio 8821 "" stdio no
scenario http 8822 ',"OCTO_FAKEACP_MCP_HTTP":"1","OCTO_FAKEACP_LOAD_SESSION":"1"' http yes
nokey
agy
echo "OK: ACP orchestrator e2e passed"
