#!/usr/bin/env bash
# End-to-end check of the parity features (docs/superpowers/specs/2026-11-12-parity-backlog.md, B1-B7) against a
# real `harness serve`, driven only with curl: instruction files (B1), the edit / glob / web_fetch tools (B2) and
# saved approval rules (B4). Mock model + scripted ACP agent + a local HTTP server; no network, no third-party agent CLI.
# Needs Go and python3. Not part of CI.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
TMP=$(mktemp -d)
PIDS=()
cleanup() { for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null || true; done; sleep 0.3; rm -rf "$TMP"; }
trap cleanup EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }
# The harness requires a bridge API token on /v1: every harness started below gets this one, every curl sends it.
export HARNESS_API_TOKEN="e2e-token-$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
curl() { command curl -H "Authorization: Bearer $HARNESS_API_TOKEN" "$@"; }
jget() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)"; }

(cd "$ROOT/apps/harness" && go build -o "$TMP/harness" ./cmd/harness && go build -o "$TMP/fakeacp" ./examples/fakeacp \
  && go build -o "$TMP/mockllm" ./examples/mockllm)
"$TMP/mockllm" --addr 127.0.0.1:8840 --delay 20ms >"$TMP/mock.log" 2>&1 & PIDS+=($!)

mkdir -p "$TMP/plugins/fake"
cat >"$TMP/plugins/fake/plugin.json" <<JSON
{"name":"fake","version":"1","agents":[{"id":"scripted","label":"Scripted","command":"$TMP/fakeacp",
 "env":{"OCTO_FAKEACP_UNIQUE_SESSIONS":"1","OCTO_FAKEACP_MODES":"1"}}]}
JSON
BASE=http://127.0.0.1:8841
HARNESS_NO_BUILTIN_PLUGINS=1 ANTHROPIC_API_KEY=mock "$TMP/harness" serve --addr 127.0.0.1:8841 --data-dir "$TMP/data" \
  --base-url http://127.0.0.1:8840 --plugins-dir "$TMP/plugins" >"$TMP/harness.log" 2>&1 & PIDS+=($!)
for _ in $(seq 60); do curl -fsS "$BASE/health" >/dev/null 2>&1 && break; sleep 0.2; done
curl -fsS "$BASE/health" >/dev/null 2>&1 || fail "harness did not start: $(cat "$TMP/harness.log")"

post() { curl -fsS -X "$1" "$BASE$2" -H 'content-type: application/json' ${3:+-d "$3"}; }
newproject() { # name access [extra json fields, leading comma] -> prints id; folder $TMP/$1
  mkdir -p "$TMP/$1" && printf '# demo\n' >"$TMP/$1/README.md"
  post POST /v1/projects "{\"name\":\"$1\",\"folders\":[{\"path\":\"$TMP/$1\"}],\"access\":\"${2:-full}\"${3:-}}" | jget 'd["id"]'
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
first_user_id() { # project -> id of the first user message of the orchestrator
  local aid; aid=$(curl -fsS "$BASE/v1/projects/$1" | jget 'd["orchestrator_agent_id"]')
  curl -fsS "$BASE/v1/projects/$1/agents/$aid/messages" | jget '[m["id"] for m in d["messages"] if m["role"]=="user"][0]'
}

echo "== B1 instruction files: listed in the receipt, capped, redacted of nothing they do not hold"
PB1=$(newproject b1)
printf 'RULE: use tabs.\n' >"$TMP/b1/AGENTS.md"
python3 - "$TMP/b1/CLAUDE.md" <<'PY'
import sys
open(sys.argv[1], "w").write("head of a very long file\n" + "filler line of text\n" * 10000)
PY
post POST "/v1/projects/$PB1/messages" '{"text":"quick look at the project"}' >/dev/null
idle "$PB1"
rc=$(curl -fsS "$BASE/v1/projects/$PB1/turns/$(first_user_id "$PB1")/context")
python3 - "$rc" <<'PY' || fail "instructions block wrong"
import json,sys
rc=json.loads(sys.argv[1])
b=[x for x in rc["blocks"] if x["name"]=="instructions"]
assert len(b)==1, rc
files={f["path"].split(":",1)[1]: f for f in b[0]["files"]}
assert files["AGENTS.md"]["truncated"] is False and files["AGENTS.md"]["size"]==len("RULE: use tabs.\n"), files
assert files["CLAUDE.md"]["truncated"] is True and files["CLAUDE.md"]["size"]>200000 and files["CLAUDE.md"]["used"]<=32768, files
assert b[0]["tokens"]<=17000, b[0]
PY
echo "   ok"

echo "== B1: an ACP orchestrator's receipt says the agent reads its own instruction files"
PB1A=$(newproject b1acp full ',"models":{"orchestrator":"acp:scripted"}')
printf 'RULE-ACP\n' >"$TMP/b1acp/AGENTS.md"
post POST "/v1/projects/$PB1A/messages" '{"text":"[echo] hi"}' >/dev/null
idle "$PB1A"
rc=$(curl -fsS "$BASE/v1/projects/$PB1A/turns/$(first_user_id "$PB1A")/context")
[ "$(jget 'd["instructions_note"]' <<<"$rc")" = "the agent reads its own instruction files" ] || fail "no ACP note: $rc"
echo "   ok"

tool_results() { # project -> all tool results of all its agents, one per line (JSON strings)
  local p=$1 aid
  for aid in $(curl -fsS "$BASE/v1/projects/$p/agents" | jget '" ".join(a["id"] for a in d["agents"])'); do
    curl -fsS "$BASE/v1/projects/$p/agents/$aid/messages" | python3 -c '
import json,sys
for m in json.load(sys.stdin)["messages"]:
    for b in m["content"]:
        if b["type"]=="tool_result": print(json.dumps(b.get("content") or ""))'
  done
}

echo "== B2 edit and glob: exact replacement, recorded like write_file, a non-unique match is an error"
PB2=$(newproject b2)
mkdir -p "$TMP/b2/src" && printf 'alpha\nbeta\ngamma\n' >"$TMP/b2/src/a.txt" && printf 'x x\n' >"$TMP/b2/dup.txt" && printf 'p\n' >"$TMP/b2/src/b.go"
post POST "/v1/projects/$PB2/messages" '{"text":"Go [edit:src/a.txt|beta|BETA] [edit:dup.txt|x|y] [glob:**/*.txt]"}' >/dev/null
idle "$PB2"
[ "$(cat "$TMP/b2/src/a.txt")" = "$(printf 'alpha\nBETA\ngamma')" ] || fail "edit did not replace: $(cat "$TMP/b2/src/a.txt")"
[ "$(cat "$TMP/b2/dup.txt")" = "x x" ] || fail "a non-unique edit changed the file"
res=$(tool_results "$PB2")
grep -q 'matches 2 places' <<<"$res" || fail "no non-unique error in: $res"
grep -q 'src/a.txt' <<<"$res" && grep -q 'dup.txt' <<<"$res" && ! grep -q 'b.go' <<<"$res" || fail "glob result wrong: $res"
curl -fsS "$BASE/v1/projects/$PB2/changes" | python3 -c '
import json,sys
files={f["path"]:f for tc in json.load(sys.stdin)["turns"] for f in tc["files"]}
assert files["src/a.txt"]["kind"]=="modified" and files["src/a.txt"]["added"]==1 and files["src/a.txt"]["removed"]==1 and "dup.txt" not in files, files' || fail "edit not recorded as a change"
echo "   ok"

echo "== B2 edit approval shows the diff, a denial note reaches the agent"
PB2S=$(newproject b2sup supervised)
printf 'alpha\nbeta\n' >"$TMP/b2sup/a.txt"
post POST "/v1/projects/$PB2S/messages" '{"text":"Go [edit:a.txt|beta|BETA]"}' >/dev/null
waitfor "the edit approvals" has_n "$PB2S" approvals 3 # the mock delegates to three sub-agents, each makes the edit
ap=$(curl -fsS "$BASE/v1/projects/$PB2S/approvals")
python3 - "$ap" <<'PY' || fail "edit approval wrong"
import json,sys
a=json.loads(sys.argv[1])["approvals"][0]
assert a["tool"]=="edit" and a["kind"]=="write" and "-beta" in a["detail"]["patch"] and "+BETA" in a["detail"]["patch"], a
PY
for id in $(jget '" ".join(a["id"] for a in d["approvals"])' <<<"$ap"); do
  post POST "/v1/projects/$PB2S/approvals/$id" '{"decision":"deny","note":"not now"}' >/dev/null
done
idle "$PB2S"
[ "$(cat "$TMP/b2sup/a.txt")" = "$(printf 'alpha\nbeta')" ] || fail "a denied edit changed the file"
res=$(tool_results "$PB2S"); grep -q 'Denied by the user: not now' <<<"$res" || fail "the denial note did not reach the agent"
echo "   ok"

echo "== B2 web_fetch: off by default, on per project, local addresses only when allowed"
mkdir -p "$TMP/site" && printf '<html><body><h1>Docs</h1><p>The answer is 42.</p></body></html>' >"$TMP/site/index.html"
(cd "$TMP/site" && exec python3 -m http.server 18842 --bind 127.0.0.1 >"$TMP/site.log" 2>&1) & PIDS+=($!)
for _ in $(seq 50); do curl -fsS http://127.0.0.1:18842/index.html >/dev/null 2>&1 && break; sleep 0.1; done
PN0=$(newproject net0)
post POST "/v1/projects/$PN0/messages" '{"text":"Go [fetch:http://127.0.0.1:18842/index.html]"}' >/dev/null; idle "$PN0"
res=$(tool_results "$PN0"); ! grep -q 'answer is 42' <<<"$res" || fail "web_fetch worked with the network off"
PN1=$(newproject net1 full ',"network":"on"')
post POST "/v1/projects/$PN1/messages" '{"text":"Go [fetch:http://127.0.0.1:18842/index.html]"}' >/dev/null; idle "$PN1"
res=$(tool_results "$PN1"); grep -q 'private' <<<"$res" || fail "a loopback fetch was not refused: $(tool_results "$PN1")"
PN2=$(newproject net2 full ',"network":"on","network_private":true')
post POST "/v1/projects/$PN2/messages" '{"text":"Go [fetch:http://127.0.0.1:18842/index.html]"}' >/dev/null; idle "$PN2"
res=$(tool_results "$PN2"); grep -q 'The answer is 42' <<<"$res" || fail "an allowed fetch returned nothing: $res / site log: $(cat "$TMP/site.log")"
echo "   ok"

answer_all() { # project decision-json : answers every pending approval until the project is idle
  local p=$1 body=$2 id
  for _ in $(seq 300); do
    for id in $(curl -fsS "$BASE/v1/projects/$p/approvals" | jget '" ".join(a["id"] for a in d["approvals"])'); do
      post POST "/v1/projects/$p/approvals/$id" "$body" >/dev/null || true
    done
    [ "$(curl -fsS "$BASE/v1/projects/$p" | jget 'd["status"]')" = idle ] && [ "$(count_of "$p" approvals)" = 0 ] && { sleep 0.3; [ "$(count_of "$p" approvals)" = 0 ] && return; }
    sleep 0.1
  done
  fail "project $p did not go idle while answering approvals"
}
http_code() { curl -s -o /dev/null -w '%{http_code}' -X "$1" "$BASE$2" -H 'content-type: application/json' ${3:+-d "$3"}; }

echo "== B4 allow_always: a saved prefix rule covers 'git status ...' and nothing compound"
PB4=$(newproject b4 supervised)
post POST "/v1/projects/$PB4/messages" '{"text":"Go [bash:git status]"}' >/dev/null
waitfor "the command approvals" has_n "$PB4" approvals 3
ap=$(curl -fsS "$BASE/v1/projects/$PB4/approvals")
python3 - "$ap" <<'PY' || fail "suggested rule wrong"
import json,sys
a=json.loads(sys.argv[1])["approvals"][0]
assert a["tool"]=="bash" and a["suggested_rule"]=={"tool":"bash","match":"git status","exact":False}, a
PY
id=$(jget 'd["approvals"][0]["id"]' <<<"$ap")
post POST "/v1/projects/$PB4/approvals/$id" '{"decision":"allow_always"}' >/dev/null
answer_all "$PB4" '{"decision":"allow"}'
rules=$(curl -fsS "$BASE/v1/projects/$PB4/approval-rules")
[ "$(jget 'len(d["rules"])' <<<"$rules")" = 1 ] && [ "$(jget 'd["rules"][0]["match"]' <<<"$rules")" = "git status" ] || fail "rule not saved once: $rules"
post POST "/v1/projects/$PB4/messages" '{"text":"Go [bash:git status --short]"}' >/dev/null
idle "$PB4"   # a covered command raises no approval: nothing blocks, nobody answers
[ "$(count_of "$PB4" approvals)" = 0 ] || fail "a covered command was asked about"
post POST "/v1/projects/$PB4/messages" '{"text":"Go [bash:git status && echo hi]"}' >/dev/null
waitfor "an approval for the compound command" has_n "$PB4" approvals 1
apc=$(curl -fsS "$BASE/v1/projects/$PB4/approvals")
[ "$(jget '"suggested_rule" in d["approvals"][0]' <<<"$apc")" = False ] || fail "a compound command carries a suggested rule"
idc=$(jget 'd["approvals"][0]["id"]' <<<"$apc")
[ "$(http_code POST "/v1/projects/$PB4/approvals/$idc" '{"decision":"allow_always"}')" = 422 ] || fail "allow_always on a compound command was not refused"
answer_all "$PB4" '{"decision":"deny","note":"no"}'
rid=$(jget 'd["rules"][0]["id"]' <<<"$rules")
[ "$(http_code DELETE "/v1/projects/$PB4/approval-rules/$rid")" = 204 ] || fail "rule delete"
[ "$(http_code DELETE "/v1/projects/$PB4/approval-rules/$rid")" = 404 ] || fail "second delete"
post POST "/v1/projects/$PB4/messages" '{"text":"Go [bash:git status]"}' >/dev/null
waitfor "an approval after the rule was deleted" has_n "$PB4" approvals 1
answer_all "$PB4" '{"decision":"deny"}'
echo "   ok"

echo "== B4: an ACP agent's permission request is covered by a saved rule too"
PB4A=$(newproject b4acp supervised ',"models":{"orchestrator":"acp:scripted"}')
post POST "/v1/projects/$PB4A/messages" '{"text":"[perm] run the tests"}' >/dev/null
waitfor "the ACP approval" has_n "$PB4A" approvals 1
ap=$(curl -fsS "$BASE/v1/projects/$PB4A/approvals")
python3 - "$ap" <<'PY' || fail "ACP suggested rule wrong"
import json,sys
a=json.loads(sys.argv[1])["approvals"][0]
assert a["tool"].startswith("acp:") and a["suggested_rule"]["match"]=="npm test", a
PY
id=$(jget 'd["approvals"][0]["id"]' <<<"$ap")
out=$(curl -s -X POST "$BASE/v1/projects/$PB4A/approvals/$id" -H "content-type: application/json" -d "{\"decision\":\"allow_always\"}"); [ -z "$out" ] || fail "allow_always on the ACP approval: $out"
idle "$PB4A"
rm -f "$TMP/b4acp/perm-ran.txt"
post POST "/v1/projects/$PB4A/messages" '{"text":"[perm] run the tests again"}' >/dev/null
idle "$PB4A"
[ "$(count_of "$PB4A" approvals)" = 0 ] && [ -f "$TMP/b4acp/perm-ran.txt" ] || fail "the saved rule did not cover the second ACP request"
echo "   ok"

agent_texts() { # project -> text of every assistant message of its orchestrator
  local aid; aid=$(curl -fsS "$BASE/v1/projects/$1" | jget 'd["orchestrator_agent_id"]')
  curl -fsS "$BASE/v1/projects/$1/agents/$aid/messages" | jget '"\n".join(b.get("text") or "" for m in d["messages"] if m["role"]=="assistant" for b in m["content"] if b["type"]=="text")'
}

echo "== B3 modes: ask refuses writes and delegation in the tool gate, a per-turn mode overrides"
PB3=$(newproject b3 full ',"mode":"ask"')
[ "$(curl -fsS "$BASE/v1/projects/$PB3" | jget 'd["mode"]')" = ask ] || fail "project mode not stored"
post POST "/v1/projects/$PB3/messages" '{"text":"Go [write:{role}.md]"}' >/dev/null; idle "$PB3"
[ "$(count_of "$PB3" agents)" = 1 ] || fail "an ask turn delegated: $(count_of "$PB3" agents) agents"
[ "$(ls "$TMP/b3" | grep -vc README)" = 0 ] || fail "an ask turn wrote files: $(ls "$TMP/b3")"
res=$(tool_results "$PB3"); grep -q 'Refused: delegating to a sub-agent is not allowed in ask mode' <<<"$res" || fail "no refusal text: $res"
post POST "/v1/projects/$PB3/messages" '{"text":"Go [write:{role}.md]","mode":"agent"}' >/dev/null; idle "$PB3"
[ "$(ls "$TMP/b3" | grep -vc README)" -ge 1 ] || fail "the agent-mode override did not write"
[ "$(http_code POST "/v1/projects/$PB3/messages" '{"text":"x","mode":"sometimes"}')" = 400 ] || fail "bad mode accepted"
echo "   ok"

echo "== B3 plan: the answer becomes a plan, approving it starts an agent turn"
PB3P=$(newproject b3plan full ',"mode":"plan"')
post POST "/v1/projects/$PB3P/messages" '{"text":"quick: plan the change"}' >/dev/null; idle "$PB3P"
plan=$(curl -fsS "$BASE/v1/projects/$PB3P/plans/latest")
[ "$(jget 'd["plan"]["status"]' <<<"$plan")" = pending ] && [ -n "$(jget 'd["plan"]["text"]' <<<"$plan")" ] || fail "no pending plan: $plan"
plid=$(jget 'd["plan"]["id"]' <<<"$plan")
[ "$(http_code POST "/v1/projects/$PB3P/plans/$plid/approve")" = 202 ] || fail "approve"
idle "$PB3P"
[ "$(curl -fsS "$BASE/v1/projects/$PB3P/plans/latest" | jget 'd["plan"]["status"]')" = approved ] || fail "plan not approved"
[ "$(http_code POST "/v1/projects/$PB3P/plans/$plid/approve")" = 409 ] || fail "second approval"
[ "$(http_code GET "/v1/projects/$PB3/plans/latest")" = 404 ] || fail "no plan must be 404"
echo "   ok"

echo "== B3 ACP: ask/plan map to the agent's own session modes"
PB3A=$(newproject b3acp full ',"models":{"orchestrator":"acp:scripted"}')
for pair in "ask:mode=ask" "plan:mode=plan" "agent:mode=default"; do
  m=${pair%%:*}; want=${pair#*:}
  post POST "/v1/projects/$PB3A/messages" "{\"text\":\"[mode] which\",\"mode\":\"$m\"}" >/dev/null; idle "$PB3A"
  txt=$(agent_texts "$PB3A"); grep -q "$want" <<<"$txt" || fail "ACP mode $m: expected $want in: $txt"
done
echo "   ok"

request_id() { # project text-fragment -> id of the orchestrator's user message containing it
  local aid; aid=$(curl -fsS "$BASE/v1/projects/$1" | jget 'd["orchestrator_agent_id"]')
  curl -fsS "$BASE/v1/projects/$1/agents/$aid/messages" | python3 -c '
import json,sys
for m in json.load(sys.stdin)["messages"]:
    t="".join(b.get("text") or "" for b in m["content"] if b["type"]=="text")
    if m["role"]=="user" and sys.argv[1] in t: print(m["id"]); break' "$2"
}

echo "== B5 rewind: dry run, restore, soft cut, conflict"
PB5=$(newproject b5)
post POST "/v1/projects/$PB5/messages" '{"text":"Alpha [bash:echo a > a.txt]"}' >/dev/null; idle "$PB5"
post POST "/v1/projects/$PB5/messages" '{"text":"Bravo [bash:echo b > b.txt && rm README.md]"}' >/dev/null; idle "$PB5"
bid=$(request_id "$PB5" Bravo)
dry=$(post POST "/v1/projects/$PB5/rewind" "{\"message_id\":$bid,\"dry_run\":true}")
python3 - "$dry" <<'PY' || fail "dry run wrong"
import json,sys
r=json.loads(sys.argv[1])
a={f["path"]:f["action"] for f in r["files"]}
assert r["dry_run"] and r["request_text"].startswith("Bravo") and a=={"b.txt":"delete","README.md":"restore"} or a=={"README.md":"restore","b.txt":"delete"}, r
assert r["conflicts"]==[] and r["messages_cut"]>0, r
PY
[ -f "$TMP/b5/b.txt" ] && [ ! -f "$TMP/b5/README.md" ] || fail "a dry run changed the files"
rep=$(post POST "/v1/projects/$PB5/rewind" "{\"message_id\":$bid}")
[ "$(jget 'd["request_text"][:5]' <<<"$rep")" = Bravo ] || fail "request text missing: $rep"
[ ! -f "$TMP/b5/b.txt" ] && [ -f "$TMP/b5/a.txt" ] && grep -q '# demo' "$TMP/b5/README.md" || fail "files not restored"
[ -z "$(request_id "$PB5" Bravo)" ] && [ -n "$(request_id "$PB5" Alpha)" ] || fail "the conversation was not cut at Bravo"
[ "$(http_code POST "/v1/projects/$PB5/rewind" "{\"message_id\":$bid}")" = 400 ] || fail "a cut request can be rewound to again"
post POST "/v1/projects/$PB5/messages" '{"text":"Charlie [bash:echo c > c.txt]"}' >/dev/null; idle "$PB5"
aid5=$(request_id "$PB5" Alpha)
printf 'by hand\n' >"$TMP/b5/c.txt"
[ "$(http_code POST "/v1/projects/$PB5/rewind" "{\"message_id\":$aid5}")" = 409 ] || fail "a hand-edited file did not stop the rewind"
[ "$(cat "$TMP/b5/c.txt")" = "by hand" ] && [ -f "$TMP/b5/a.txt" ] || fail "a refused rewind changed files"
echo "   ok"

echo "== B6 steer: send-now injects the message at the next tool boundary; ACP answers 409 steer_unsupported"
PB6=$(newproject b6)
post POST "/v1/projects/$PB6/messages" '{"text":"Go [bash:sleep 2]"}' >/dev/null
waitfor "the turn to run" test "$(curl -fsS "$BASE/v1/projects/$PB6" | jget 'd["status"]')" = running
qid=$(post POST "/v1/projects/$PB6/messages" '{"text":"steer: also mention the tests"}' | jget 'd["queued"]["id"]')
out=$(post POST "/v1/projects/$PB6/queue/$qid/send-now")
[ "$(jget 'd.get("steered")' <<<"$out")" = True ] || fail "send-now did not steer: $out"
idle "$PB6"
aid6=$(curl -fsS "$BASE/v1/projects/$PB6" | jget 'd["orchestrator_agent_id"]')
curl -fsS "$BASE/v1/projects/$PB6/agents/$aid6/messages" | python3 -c '
import json,sys
ms=json.load(sys.stdin)["messages"]
texts=[(m["role"],"".join(b.get("text") or "" for b in m["content"] if b["type"]=="text")) for m in ms]
i=[k for k,(r,t) in enumerate(texts) if r=="user" and t.startswith("steer:")]
assert i, texts
assert any(r=="assistant" and t for r,t in texts[i[0]+1:]), "no answer after the steered message"
assert sum(1 for r,t in texts if r=="user" and t.startswith("Go ["))==1, texts' || fail "steered message not injected into the same turn"
[ "$(count_of "$PB6" queue 2>/dev/null || curl -fsS "$BASE/v1/projects/$PB6/queue" | jget 'len(d["messages"])')" = 0 ] || fail "queue not empty"
PB6A=$(newproject b6acp full ',"models":{"orchestrator":"acp:scripted"}')
post POST "/v1/projects/$PB6A/messages" '{"text":"[hang] stuck"}' >/dev/null
waitfor "the ACP turn to run" test "$(curl -fsS "$BASE/v1/projects/$PB6A" | jget 'd["status"]')" = running
qa=$(post POST "/v1/projects/$PB6A/messages" '{"text":"[echo] next"}' | jget 'd["queued"]["id"]')
[ "$(http_code POST "/v1/projects/$PB6A/queue/$qa/send-now")" = 409 ] || fail "ACP send-now was not 409"
[ "$(curl -s -X POST "$BASE/v1/projects/$PB6A/queue/$qa/send-now" | jget 'd["error"]["code"]')" = steer_unsupported ] || fail "wrong code"
[ "$(http_code POST "/v1/projects/$PB6A/queue/$qa/send-now" '{"interrupt":true}')" = 202 ] || fail "interrupt send-now"
idle "$PB6A"
echo "   ok"

echo "== B7 history: manual compaction marker, Markdown export without secrets, search over projects, context report"
PB7=$(newproject b7)
SEC="sk-e2e-b7-Qw93kLm20xZp"
post PUT "/v1/projects/$PB7/secrets/B7_KEY" "{\"value\":\"$SEC\"}" >/dev/null
post POST "/v1/projects/$PB7/messages" "{\"text\":\"quick walrus question, the key is $SEC\"}" >/dev/null; idle "$PB7"
post POST "/v1/projects/$PB7/messages" '{"text":"quick second question"}' >/dev/null; idle "$PB7"
ctx0=$(curl -fsS "$BASE/v1/projects/$PB7/context")
python3 - "$ctx0" <<'PY' || fail "context report wrong"
import json,sys
c=json.loads(sys.argv[1])
assert c["source"]=="harness" and c["window"]==200000 and c["window_source"]=="default", c
assert sum(x["tokens"] for x in c["categories"])==c["used_tokens"]>0, c
assert c["last_request"]["input"]>0 and c["free_tokens"]==c["window"]-c["used_tokens"]-c["reserved_tokens"], c
assert "agent_id" in c and "parts" in c and "window_tokens" in c and "estimated" in c, c
PY
comp=$(post POST "/v1/projects/$PB7/compact")
[ "$(jget 'd["manual"]' <<<"$comp")" = True ] && [ "$(jget 'd["message_count"]>=4' <<<"$comp")" = True ] || fail "compact result: $comp"
[ "$(http_code POST "/v1/projects/$PB7/compact")" = 409 ] || fail "compacting twice was not refused"
aid7=$(curl -fsS "$BASE/v1/projects/$PB7" | jget 'd["orchestrator_agent_id"]')
curl -fsS "$BASE/v1/projects/$PB7/agents/$aid7/messages" | python3 -c '
import json,sys
d=json.load(sys.stdin)
c=d["compactions"]
assert len(c)==1 and c[0]["manual"] and c[0]["label"]=="history compacted" and c[0]["message_count"]>=4, c' || fail "no marker on the message list"
[ -n "$(jget '"compacted_at" in d and d["compacted_at"]' <<<"$(curl -fsS "$BASE/v1/projects/$PB7/context")")" ] || fail "compacted_at missing"
md=$(curl -fsS "$BASE/v1/projects/$PB7/export?format=md")
grep -q '## Request 1' <<<"$md" && grep -q 'History compacted on request' <<<"$md" || fail "export incomplete: $md"
! grep -q "$SEC" <<<"$md" || fail "the export holds the secret"
[ "$(http_code GET "/v1/projects/$PB7/export?format=pdf")" = 400 ] || fail "bad export format"
PB7B=$(newproject b7b)
post POST "/v1/projects/$PB7B/messages" '{"text":"quick another walrus"}' >/dev/null; idle "$PB7B"
sr=$(curl -fsS "$BASE/v1/search?q=walrus")
python3 - "$sr" "$PB7" "$PB7B" <<'PY' || fail "search wrong: $sr"
import json,sys
r=json.loads(sys.argv[1])["results"]
assert {x["project_id"] for x in r}=={sys.argv[2],sys.argv[3]} and all("walrus" in x["snippet"] for x in r), r
assert all(sys.argv[2] not in x["snippet"] for x in r)
PY
[ "$(http_code GET "/v1/search")" = 400 ] || fail "empty search"
echo "   ok"

echo "PARITY OK (B1, B2, B3, B4, B5, B6, B7)"
