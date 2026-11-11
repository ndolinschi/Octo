#!/usr/bin/env bash
# End-to-end check of the harness against a REAL Octo router (integration I1).
# The harness talks to the router's autoroute path (--base-url .../autoroute), where hints and result headers live.
#   router :8811  ->  mock upstream :8812     harness :8815 (via router), :8816 (direct to the mock)
# Needs `cargo build -p octo` (target/debug/octo) and Go. Touches only a temp dir.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
TMP=$(mktemp -d)
PIDS=()
cleanup() { for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null || true; done; rm -rf "$TMP"; }
trap cleanup EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }
jget() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)"; }

(cd "$ROOT/apps/harness" && go build -o "$TMP/harness" ./cmd/harness && go build -o "$TMP/mockllm" ./examples/mockllm)

# Router config: ports, mock upstream, a throwaway history db, ruinous prices so $0.01 is one request.
cp -r "$ROOT/apps/router/config" "$TMP/config"
sed -i 's|^bind_addr = .*|bind_addr = "127.0.0.1:8811"|' "$TMP/config/server.toml"
sed -i "s|^messages_url = .*|messages_url = \"http://127.0.0.1:8812/v1/messages\"|; s|^decisions_url = .*|decisions_url = \"http://127.0.0.1:8812/decisions\"|" "$TMP/config/openrouter.toml"
sed -i "s|^database_path = .*|database_path = \"$TMP/history.sqlite\"|" "$TMP/config/history.toml"
: > "$TMP/config/prices.toml"
for slug in deepseek/deepseek-v4.1-flash minimax/minimax-m3.1-flash deepseek/deepseek-v4.1-flash-1017; do
  printf '[prices."%s"]\ninput = 5000.0\ncache_read = 500.0\ncache_write = 6000.0\noutput = 25000.0\n' "$slug" >> "$TMP/config/prices.toml"
done

"$TMP/mockllm" --addr 127.0.0.1:8812 --delay 1ms >"$TMP/mock.log" 2>&1 & PIDS+=($!)
(cd "$TMP" && exec env OCTO_CONFIG="$TMP/config" "$ROOT/target/debug/octo" >"$TMP/router.log" 2>&1) & PIDS+=($!)
for _ in $(seq 100); do curl -fsS http://127.0.0.1:8811/health >/dev/null 2>&1 && break || sleep 0.2; done
curl -fsS http://127.0.0.1:8811/health | grep -q '"service":"octo"' || fail "router not up: $(cat "$TMP/router.log")"
# Harnesses start after the router: detection happens at start-up (a late router is found by the minute re-probe).
ANTHROPIC_API_KEY=mock "$TMP/harness" serve --addr 127.0.0.1:8815 --data-dir "$TMP/h1" --base-url http://127.0.0.1:8811/autoroute >"$TMP/h1.log" 2>&1 & PIDS+=($!)
ANTHROPIC_API_KEY=mock "$TMP/harness" serve --addr 127.0.0.1:8816 --data-dir "$TMP/h2" --base-url http://127.0.0.1:8812 >"$TMP/h2.log" 2>&1 & PIDS+=($!)
for url in http://127.0.0.1:8815/health http://127.0.0.1:8816/health; do
  for _ in $(seq 50); do curl -fsS "$url" >/dev/null 2>&1 && break || sleep 0.2; done
done

new_project() { # $1 bridge, $2 extra json
  mkdir -p "$TMP/ws"
  curl -fsS -X POST "$1/v1/projects" -H 'content-type: application/json' \
    -d "{\"name\":\"e2e\",\"max_depth\":1,\"folders\":[{\"path\":\"$TMP/ws\"}]$2}" | jget 'd["id"]'
}
run_turn() { # $1 bridge, $2 project, $3 text -> prints turn status
  local before after
  curl -fsS -X POST "$1/v1/projects/$2/messages" -H 'content-type: application/json' -d "{\"text\":\"$3\"}" >/dev/null
  for _ in $(seq 150); do
    sleep 0.2
    st=$(curl -fsS "$1/v1/projects/$2" | jget 'd["status"]')
    [ "$st" = idle ] && break
  done
  curl -fsS "$1/v1/projects/$2/agents" | jget '[a for a in d["agents"] if a["parent_id"] is None][0]["error"] or "ok"'
}

echo "== config"
curl -fsS http://127.0.0.1:8815/v1/config | jget 'd["router"], d["router_capabilities"]' | grep -q "True" || fail "harness 8815 did not detect the router"
curl -fsS http://127.0.0.1:8816/v1/config | jget 'd["router"]' | grep -q "False" || fail "harness 8816 detected a router at the mock"

echo "== (1) three sub-agents, one budget key, served model / tier / trigger / router cost in /v1/usage"
P1=$(new_project http://127.0.0.1:8815 "")
res=$(run_turn http://127.0.0.1:8815 "$P1" "build it")
[ "$res" = ok ] || fail "turn 1 error: $res"
curl -fsS "http://127.0.0.1:8815/v1/usage?group=model&project=$P1" | tee "$TMP/usage.json" | \
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
P2=$(new_project http://127.0.0.1:8815 ',"budget_usd":0.01')
n_before=$(curl -fsS "http://127.0.0.1:8815/v1/usage?group=day&project=$P2" | jget 'd["total"]["requests"]')
res=$(run_turn http://127.0.0.1:8815 "$P2" "build it")
echo "orchestrator error: $res"
echo "$res" | grep -Eq '^Project budget reached \(\$[0-9.]+ of \$0\.01\)$' || fail "no budget message"
sleep 1
n1=$(curl -fsS "http://127.0.0.1:8815/v1/usage?group=day&project=$P2" | jget 'd["total"]["requests"]')
sleep 1
n2=$(curl -fsS "http://127.0.0.1:8815/v1/usage?group=day&project=$P2" | jget 'd["total"]["requests"]')
[ "$n1" = "$n2" ] || fail "requests kept coming after the turn stopped ($n1 -> $n2)"
curl -fsS "http://127.0.0.1:8815/v1/projects/$P2" | jget 'd["budget_usd"], d["spent_usd"]'

echo "== (5) non-Octo base URL: nothing changes"
P3=$(new_project http://127.0.0.1:8816 "")
res=$(run_turn http://127.0.0.1:8816 "$P3" "build it")
[ "$res" = ok ] || fail "direct turn error: $res"
curl -fsS "http://127.0.0.1:8816/v1/usage?group=model&project=$P3" | jget '[b["key"] for b in d["buckets"]]' | grep -q "claude" || fail "direct run should be keyed by the requested models"
echo "OK"
