#!/usr/bin/env bash
# End-to-end check of the v7 harness features against a real `harness serve`, driven only with curl:
# changes and diffs (bash snapshots, revert), approvals (built-in tools and an ACP agent), the message queue,
# forms and secrets (the secret value must appear nowhere), and the default access mode.
# Mock model + scripted ACP agent; no network, no third-party agent CLI. Needs Go and python3.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
TMP=$(mktemp -d)
PIDS=()
cleanup() { for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null || true; done; sleep 0.3; rm -rf "$TMP"; }
trap cleanup EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }
jget() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)"; }
SECRET="sk-e2e-Zq81xT0pL9vB"

(cd "$ROOT/apps/harness" && go build -o "$TMP/harness" ./cmd/harness && go build -o "$TMP/fakeacp" ./examples/fakeacp \
  && go build -o "$TMP/mockllm" ./examples/mockllm)
"$TMP/mockllm" --addr 127.0.0.1:8830 --delay 50ms >"$TMP/mock.log" 2>&1 & PIDS+=($!)

mkdir -p "$TMP/plugins/fake"
cat >"$TMP/plugins/fake/plugin.json" <<JSON
{"name":"fake","version":"1","agents":[{"id":"scripted","label":"Scripted","command":"$TMP/fakeacp",
 "env":{"OCTO_FAKEACP_UNIQUE_SESSIONS":"1"}}]}
JSON
BASE=http://127.0.0.1:8831
HARNESS_DEFAULT_ACCESS=supervised HARNESS_NO_BUILTIN_PLUGINS=1 ANTHROPIC_API_KEY=mock "$TMP/harness" serve --addr 127.0.0.1:8831 --data-dir "$TMP/data" \
  --base-url http://127.0.0.1:8830 --plugins-dir "$TMP/plugins" >"$TMP/harness.log" 2>&1 & PIDS+=($!)
for _ in $(seq 60); do curl -fsS "$BASE/health" >/dev/null 2>&1 && break; sleep 0.2; done
curl -fsS "$BASE/health" >/dev/null 2>&1 || fail "harness did not start: $(cat "$TMP/harness.log")"

post() { curl -fsS -X "$1" "$BASE$2" -H 'content-type: application/json' ${3:+-d "$3"}; }
newproject() { # name access [orchestrator] -> prints id; folder $TMP/$1
  mkdir -p "$TMP/$1" && printf '# demo\n' >"$TMP/$1/README.md"
  local models=""; [ -n "${3:-}" ] && models=",\"models\":{\"orchestrator\":\"$3\"}"
  local access=""; [ -n "${2:-}" ] && access=",\"access\":\"$2\""
  post POST /v1/projects "{\"name\":\"$1\",\"folders\":[{\"path\":\"$TMP/$1\"}]$access$models}" | jget 'd["id"]'
}
idle() { # project: wait for status idle and an empty queue
  for _ in $(seq 300); do
    s=$(curl -fsS "$BASE/v1/projects/$1" | jget 'd["status"]'); q=$(curl -fsS "$BASE/v1/projects/$1/queue" | jget 'len(d["messages"])')
    [ "$s" = idle ] && [ "$q" = 0 ] && { sleep 0.3; [ "$(curl -fsS "$BASE/v1/projects/$1" | jget 'd["status"]')" = idle ] && return; }
    sleep 0.2
  done
  fail "project $1 did not go idle"
}
waitfor() { # description, command... : retries for ~30s
  local what=$1; shift
  for _ in $(seq 300); do "$@" >/dev/null 2>&1 && return; sleep 0.2; done
  fail "timed out waiting for $what"
}
count_of() { curl -fsS "$BASE/v1/projects/$1/$2" | jget "len(d[\"$2\"])"; }
has_n() { [ "$(count_of "$1" "$2")" -ge "$3" ]; }

echo "== default access (HARNESS_DEFAULT_ACCESS=supervised is honoured)"
P0=$(newproject default)
[ "$(curl -fsS "$BASE/v1/projects/$P0" | jget 'd["access"]')" = supervised ] || fail "a new project is not supervised by default"
code=$(curl -s -o /dev/null -w '%{http_code}' -X PATCH "$BASE/v1/projects/$P0" -H 'content-type: application/json' -d '{"access":"root"}')
[ "$code" = 400 ] || fail "bad access value gave $code"

echo "== changes: a bash command's files are recorded, shown and reverted"
P1=$(newproject changes full)
post POST "/v1/projects/$P1/messages" '{"text":"Go [bash:echo hi > made.txt && rm README.md]"}' >/dev/null
idle "$P1"
turns=$(curl -fsS "$BASE/v1/projects/$P1/changes")
python3 - "$turns" <<'PY' || fail "changes summary wrong"
import json,sys
t=json.loads(sys.argv[1])["turns"]
files={f["path"]:f for tc in t for f in tc["files"]}
assert files["made.txt"]["kind"]=="created" and files["made.txt"]["added"]==1, files
assert files["README.md"]["kind"]=="deleted" and files["README.md"]["removed"]==1, files
PY
cid=$(jget '[f["change_ids"][0] for tc in d["turns"] for f in tc["files"] if f["path"]=="README.md"][0]' <<<"$turns")
detail=$(curl -fsS "$BASE/v1/projects/$P1/changes/$cid")
[ "$(jget 'd["diff_available"]' <<<"$detail")" = True ] || fail "no diff for the deleted file"
post POST "/v1/projects/$P1/changes/$cid/revert" >/dev/null
grep -q '# demo' "$TMP/changes/README.md" || fail "revert did not restore README.md"

echo "== approvals: supervised built-in sub-agents wait for the user"
P2=$(newproject approvals supervised)
post POST "/v1/projects/$P2/messages" '{"text":"Go [write:{role}.md]"}' >/dev/null
waitfor "three approvals" has_n "$P2" approvals 3
[ "$(curl -fsS "$BASE/v1/projects/$P2" | jget 'd["needs_you"]')" = True ] || fail "project does not say needs_you"
ids=$(curl -fsS "$BASE/v1/projects/$P2/approvals" | jget '" ".join(a["id"] for a in d["approvals"])')
n=0
for id in $ids; do
  if [ $n = 0 ]; then body='{"decision":"deny","note":"not this one"}'; else body='{"decision":"allow"}'; fi
  post POST "/v1/projects/$P2/approvals/$id" "$body" >/dev/null; n=$((n+1))
done
idle "$P2"
[ "$(ls "$TMP/approvals" | grep -c '\.md$')" = 3 ] || [ "$(ls "$TMP/approvals" | grep -vc README)" = 2 ] || fail "expected two allowed writes: $(ls "$TMP/approvals")"

echo "== approvals: an ACP agent's permission request, options mapped"
P3=$(newproject acp supervised acp:scripted)
post POST "/v1/projects/$P3/messages" '{"text":"[perm] run the tests"}' >/dev/null
waitfor "the ACP approval" has_n "$P3" approvals 1
ap=$(curl -fsS "$BASE/v1/projects/$P3/approvals")
python3 - "$ap" <<'PY' || fail "ACP approval wrong"
import json,sys
a=json.loads(sys.argv[1])["approvals"][0]
assert a["kind"]=="acp" and a["agent_label"]=="scripted" and a["detail"]["command"]=="npm test" and len(a["detail"]["options"])==4, a
PY
id=$(jget 'd["approvals"][0]["id"]' <<<"$ap")
post POST "/v1/projects/$P3/approvals/$id" '{"decision":"allow","option_id":"p-allow-always"}' >/dev/null
idle "$P3"
[ -f "$TMP/acp/perm-ran.txt" ] || fail "the allowed command did not run"
post POST "/v1/projects/$P3/messages" '{"text":"[own-edit] edit by yourself"}' >/dev/null
idle "$P3"
curl -fsS "$BASE/v1/projects/$P3/changes" | python3 -c '
import json,sys
files={f["path"]:f for tc in json.load(sys.stdin)["turns"] for f in tc["files"]}
assert files["own-edit.txt"]["source"]=="acp_turn" and files["README.md"]["kind"]=="modified", files' || fail "the agent's own edits were not recorded"

echo "== queue: messages sent during a turn run in order"
P4=$(newproject queue full)
post POST "/v1/projects/$P4/messages" '{"text":"quick one"}' >/dev/null
for t in two three four; do
  [ "$(post POST "/v1/projects/$P4/messages" "{\"text\":\"quick $t\"}" | jget '"queued" in d')" = True ] || fail "quick $t was not queued"
done
q=$(curl -fsS "$BASE/v1/projects/$P4/queue")
qid=$(jget 'd["messages"][2]["id"]' <<<"$q")
curl -fsS -X DELETE "$BASE/v1/projects/$P4/queue/$qid" -o /dev/null
idle "$P4"
orch=$(curl -fsS "$BASE/v1/projects/$P4" | jget 'd["orchestrator_agent_id"]')
texts=$(curl -fsS "$BASE/v1/projects/$P4/agents/$orch/messages" | jget '"|".join(m["content"][0]["text"] for m in d["messages"] if m["role"]=="user" and m["content"][0]["type"]=="text")')
[ "$texts" = "quick one|quick two|quick three" ] || fail "turn order: $texts"

echo "== forms and secrets: the value never leaves the harness"
P5=$(newproject forms full)
post POST "/v1/projects/$P5/messages" '{"text":"[form] set it up"}' >/dev/null
waitfor "the form" has_n "$P5" inputs 1
iid=$(curl -fsS "$BASE/v1/projects/$P5/inputs" | jget 'd["inputs"][0]["id"]')
code=$(curl -s -o "$TMP/bad.json" -w '%{http_code}' -X POST "$BASE/v1/projects/$P5/inputs/$iid" -H 'content-type: application/json' -d "{\"values\":{\"api_key\":\"$SECRET\",\"nope\":\"x\"}}")
[ "$code" = 400 ] && ! grep -q "$SECRET" "$TMP/bad.json" || fail "bad submission: $code"
post POST "/v1/projects/$P5/inputs/$iid" "{\"values\":{\"api_key\":\"$SECRET\",\"region\":\"eu-west-1\"}}" >/dev/null
idle "$P5"
[ "$(curl -fsS "$BASE/v1/projects/$P5/secrets" | jget '[s["name"] for s in d["secrets"]]')" = "['api_key']" ] || fail "secret names"
[ "$(stat -c %a "$TMP/data/projects/$P5/secrets.json")" = 600 ] || fail "secrets.json is not 0600"
for path in "" /agents /secrets /inputs /context /changes; do
  curl -fsS "$BASE/v1/projects/$P5$path" | grep -q "$SECRET" && fail "the secret is in GET $path"
done
for a in $(curl -fsS "$BASE/v1/projects/$P5/agents" | jget '" ".join(a["id"] for a in d["agents"])'); do
  curl -fsS "$BASE/v1/projects/$P5/agents/$a/messages" | grep -q "$SECRET" && fail "the secret is in a transcript"
done
curl -fsS "$BASE/v1/usage" | grep -q "$SECRET" && fail "the secret is in usage"
grep -q "$SECRET" "$TMP/harness.log" && fail "the secret is in the harness log"
grep -q "$SECRET" "$TMP/mock.log" && fail "the secret reached the model server"
curl -fsS -X DELETE "$BASE/v1/projects/$P5/secrets/api_key" -o /dev/null

echo "== memory (M1): task record, digest, search, files"
P6=$(newproject memory full)
post POST "/v1/projects/$P6/messages" '{"text":"quick: Нужно уложиться в бюджет проекта [goal: Уложиться в бюджет] [fact: The dev server port is 8790] [quote: Нужно уложиться в бюджет]"}' >/dev/null
idle "$P6"
nfacts() { [ "$(curl -fsS "$BASE/v1/projects/$P6/tasks" | jget 'sum(len(t["facts"]) for t in d["tasks"])')" -ge "$1" ]; }
waitfor "the digest" nfacts 1
curl -fsS "$BASE/v1/projects/$P6/tasks" | python3 -c '
import json,sys
t=json.load(sys.stdin)["tasks"][0]
assert t["goal_by"]=="digest" and t["goal"]=="Уложиться в бюджет" and t["quotes"][0]["text"]=="Нужно уложиться в бюджет", t' || fail "task record not digested"
post POST "/v1/projects/$P6/messages" '{"text":"quick: the port is 8791 now [fact: The dev server port is 8791 | supersedes: The dev server port is 8790]"}' >/dev/null
idle "$P6"
waitfor "the second digest" nfacts 2
hits=$(curl -fsS "$BASE/v1/projects/$P6/memory/search?q=dev%20server%20port&in=facts")
python3 - "$hits" <<'PY' || fail "superseded fact not ranked after the current one"
import json,sys
h=json.loads(sys.argv[1])["hits"]
assert len(h)==2 and not h[0].get("superseded") and h[1]["superseded"] and "8791" in h[0]["snippet"], h
PY
ru=$(curl -fsS "$BASE/v1/projects/$P6/memory/search?q=%D0%B1%D1%8E%D0%B4%D0%B6%D0%B5%D1%82%D0%B0")
[ "$(jget 'len(d["hits"])>0' <<<"$ru")" = True ] || fail "an inflected Russian word was not found"
none=$(curl -fsS "$BASE/v1/projects/$P6/memory/search?q=hovercraft")
[ "$(jget 'd["message"]' <<<"$none")" = "nothing in memory matches" ] || fail "an empty search did not say so"
post PUT "/v1/projects/$P6/memory/notes/arch.md" '{"content":"we use sqlite with fts5","summary":"architecture"}' >/dev/null
[ "$(curl -fsS "$BASE/v1/projects/$P6/memory/search?q=fts5&in=files" | jget 'len(d["hits"])')" = 1 ] || fail "memory file not searchable"
curl -fsS -X DELETE "$BASE/v1/projects/$P6/memory/notes/arch.md" -o /dev/null
[ "$(curl -fsS "$BASE/v1/projects/$P6/memory/search?q=fts5&in=files" | jget 'len(d["hits"])')" = 0 ] || fail "a deleted memory file is still indexed"

echo "== no leftover processes"
kill "${PIDS[@]}" 2>/dev/null || true
sleep 1
if pgrep -f "$TMP/(harness|fakeacp|mockllm)" >/dev/null; then fail "processes left: $(pgrep -fa "$TMP/")"; fi
PIDS=()
echo "OK: v7 e2e passed"
