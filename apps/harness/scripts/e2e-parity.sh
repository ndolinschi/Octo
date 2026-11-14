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
 "env":{"OCTO_FAKEACP_UNIQUE_SESSIONS":"1","OCTO_FAKEACP_MODES":"1","OCTO_FAKEACP_COMMANDS":"web|Search the web|query;init|Set up the project"}},
 {"id":"imager","label":"Imager","command":"$TMP/fakeacp",
 "env":{"OCTO_FAKEACP_UNIQUE_SESSIONS":"1","OCTO_FAKEACP_PROMPT_IMAGE":"1"}}]}
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
nop=$(curl -fsS "$BASE/v1/projects/$PB3/plans/latest") || fail "no plan must answer 200"
[ "$(jget 'd["plan"]' <<<"$nop")" = None ] || fail "no plan must be {\"plan\": null}: $nop"
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

echo "== B11 slash commands: Octo's and the agent's, /clear with a carried-over summary, /remember"
PB11=$(newproject b11)
post POST "/v1/projects/$PB11/messages" '{"text":"quick narwhal question"}' >/dev/null; idle "$PB11"
sc=$(curl -fsS "$BASE/v1/projects/$PB11/slash-commands")
python3 - "$sc" <<'PY' || fail "built-in slash commands wrong: $sc"
import json,sys
d=json.loads(sys.argv[1])
assert d["agent"] is None, d
names={c["name"]:c for c in d["octo"]}
assert {"compact","clear","mode","model","rewind","export","review","context","memory","settings","remember","help"} <= set(names), names
assert names["compact"]["available"] and names["clear"]["endpoint"].endswith("/clear"), names
PY
for t in '/clear' '/compact now' '/remember x'; do
  [ "$(curl -s -X POST "$BASE/v1/projects/$PB11/messages" -H 'content-type: application/json' -d "{\"text\":\"$t\"}" | jget 'd["error"]["code"]')" = octo_command ] || fail "$t was not refused as an Octo command"
done
cl=$(post POST "/v1/projects/$PB11/clear")
python3 - "$cl" <<'PY' || fail "clear result wrong: $cl"
import json,sys
d=json.loads(sys.argv[1])
assert d["conversation_id"] and d["summary_source"]=="model" and d["summary"] and "narwhal" in d["title"], d
PY
aid11=$(curl -fsS "$BASE/v1/projects/$PB11" | jget 'd["orchestrator_agent_id"]')
curl -fsS "$BASE/v1/projects/$PB11/agents/$aid11/messages" | python3 -c '
import json,sys
d=json.load(sys.stdin)
# Schema 15: /clear starts a new default session with its own root agent; it holds no message yet and starts with the
# marker (the old session keeps its messages on its own root).
assert len(d["messages"])==0 and len(d["conversations"])==1 and d["conversations"][0]["label"].startswith("New session"), d["conversations"]' || fail "no new-session marker"
curl -fsS "$BASE/v1/search?q=narwhal" | grep -q "$PB11" || fail "an old request is not found after /clear"
curl -fsS "$BASE/v1/projects/$PB11/export?format=md" | grep -q 'New session' || fail "export has no new-session marker"
fact=$(post POST "/v1/projects/$PB11/facts" '{"text":"narwhals are not unicorns","kind":"fact"}')
tid=$(jget 'd["task_id"]' <<<"$fact"); fid=$(jget 'd["fact"]["id"]' <<<"$fact")
[ "$(http_code DELETE "/v1/projects/$PB11/facts/$tid/$fid")" = 204 ] || fail "undo of a remembered fact"
PB11A=$(newproject b11a full ',"models":{"orchestrator":"acp:scripted"}')
[ "$(curl -fsS "$BASE/v1/projects/$PB11A/slash-commands" | jget 'd["agent"]["pending"]')" = True ] || fail "agent list not pending before the first session"
post POST "/v1/projects/$PB11A/messages" '{"text":"[echo] hello"}' >/dev/null; idle "$PB11A"
curl -fsS "$BASE/v1/projects/$PB11A/slash-commands" | python3 -c '
import json,sys
a=json.load(sys.stdin)["agent"]
assert not a.get("pending") and [c["name"] for c in a["commands"]]==["web","init"] and a["commands"][0]["input_hint"]=="query", a' || fail "agent commands wrong"
post POST "/v1/projects/$PB11A/messages" '{"text":"/web rust"}' >/dev/null; idle "$PB11A"
aid11a=$(curl -fsS "$BASE/v1/projects/$PB11A" | jget 'd["orchestrator_agent_id"]')
curl -fsS "$BASE/v1/projects/$PB11A/agents/$aid11a/messages" | python3 -c '
import json,sys
m=json.load(sys.stdin)["messages"]
assert [x.get("command") for x in m if x["role"]=="user"]==[None,"web"], m
assert any("command<</web rust>>" in b.get("text","") for x in m for b in x["content"]), m' || fail "agent command not passed through"
cla=$(post POST "/v1/projects/$PB11A/clear")
python3 - "$cla" <<'PY' || fail "ACP clear wrong: $cla"
import json,sys
d=json.loads(sys.argv[1])
assert d["summary_source"]=="agent" and "Agent summary" in d["summary"], d
PY
[ "$(curl -fsS "$BASE/v1/projects/$PB11A/slash-commands" | jget 'd["agent"]["pending"]')" = True ] || fail "agent list not pending after /clear"
echo "   ok"

last_text() { # project -> text of the orchestrator's last assistant message
  local aid; aid=$(curl -fsS "$BASE/v1/projects/$1" | jget 'd["orchestrator_agent_id"]')
  curl -fsS "$BASE/v1/projects/$1/agents/$aid/messages" | python3 -c '
import json,sys
m=[x for x in json.load(sys.stdin)["messages"] if x["role"]=="assistant"]
print("".join(b.get("text") or "" for b in m[-1]["content"]) if m else "")'
}
side_msgs() { curl -fsS "$BASE/v1/projects/$1/side" | jget 'len(d["messages"])'; }
side_last() { curl -fsS "$BASE/v1/projects/$1/side" | jget 'd["messages"][-1]["text"]'; }
ask_side() { # project text n: asks and waits until the conversation holds n messages
  post POST "/v1/projects/$1/side" "{\"text\":\"$2\"}" >/dev/null
  waitfor "side answer $3" bash -c "[ \"\$(curl -fsS -H 'Authorization: Bearer $HARNESS_API_TOKEN' $BASE/v1/projects/$1/side | python3 -c 'import json,sys; print(len(json.load(sys.stdin)[\"messages\"]))')\" -ge $3 ]"
}
pid_of() { sed -n 's/.*pid=\([0-9]*\) .*/\1/p' <<<"$1" | head -1; }

echo "== B13 side question on the project's own ACP agent: own session, kept for follow-ups, closed on clear"
PB13=$(newproject b13 full ',"models":{"orchestrator":"acp:scripted"}')
post POST "/v1/projects/$PB13/messages" '{"text":"[echo] main"}' >/dev/null; idle "$PB13"
orch_pid=$(pid_of "$(last_text "$PB13")")
ask_side "$PB13" "[echo] one" 2
t1=$(side_last "$PB13"); p1=$(pid_of "$t1")
[ -n "$p1" ] && [ "$p1" != "$orch_pid" ] || fail "the side question shares the orchestrator's agent ($p1 / $orch_pid)"
grep -q 'You answer side questions' <<<"$t1" || fail "no briefing in the first side prompt: $t1"
ask_side "$PB13" "[echo] two" 4
t2=$(side_last "$PB13")
[ "$(pid_of "$t2")" = "$p1" ] || fail "the follow-up opened another agent"
! grep -q 'You answer side questions' <<<"$t2" || fail "the follow-up repeated the briefing"
[ "$(http_code POST "/v1/projects/$PB13/side/stop")" = 204 ] || fail "side stop"
ask_side "$PB13" "[fswrite] write" 6
[ ! -e "$TMP/b13/fswrite.txt" ] || fail "the side agent wrote a file"
grep -qi refused <<<"$(side_last "$PB13")" || fail "the write was not refused: $(side_last "$PB13")"
[ "$(http_code DELETE "/v1/projects/$PB13/side")" = 204 ] || fail "clear side"
ask_side "$PB13" "[echo] three" 2
[ "$(pid_of "$(side_last "$PB13")")" != "$p1" ] || fail "a cleared side conversation reused the old agent"
echo "   ok"

echo "== B12 attach images: upload limits, sniffing, image blocks to the model and to an ACP agent, 422 without the capability"
python3 - "$TMP/pic.png" <<'PY'
import struct, sys, zlib
def chunk(t, d): return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xffffffff)
w = h = 4
raw = b"".join(b"\x00" + b"\xff\x00\x00" * w for _ in range(h))
open(sys.argv[1], "wb").write(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))
PY
printf '<html><script>1</script></html>' >"$TMP/fake.png"
PB12=$(newproject b12)
up=$(curl -fsS -X POST "$BASE/v1/projects/$PB12/attachments?name=pic.png" -H 'content-type: image/png' --data-binary @"$TMP/pic.png")
python3 - "$up" <<'PY' || fail "upload result: $up"
import json,sys
a=json.loads(sys.argv[1])
assert a["media_type"]=="image/png" and a["width"]==4 and a["height"]==4 and a["id"].startswith("att_") and a["name"]=="pic.png", a
PY
AID=$(jget 'd["id"]' <<<"$up")
code=$(command curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $HARNESS_API_TOKEN" -X POST "$BASE/v1/projects/$PB12/attachments" -H 'content-type: image/png' --data-binary @"$TMP/fake.png")
[ "$code" = 415 ] || fail "html sent as image/png: $code"
head -c 6000000 /dev/zero >"$TMP/big.bin"; cat "$TMP/pic.png" "$TMP/big.bin" >"$TMP/big.png"
code=$(command curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $HARNESS_API_TOKEN" -X POST "$BASE/v1/projects/$PB12/attachments" -H 'content-type: image/png' --data-binary @"$TMP/big.png")
[ "$code" = 413 ] || fail "6 MB image: $code"
curl -fsS "$BASE/v1/projects/$PB12/attachments/$AID" | cmp -s - "$TMP/pic.png" || fail "attachment bytes differ"
post POST "/v1/projects/$PB12/messages" "{\"text\":\"quick what is this\",\"attachments\":[\"$AID\"]}" >/dev/null; idle "$PB12"
c=$(curl -fsS "$BASE/v1/projects/$PB12/context")
[ "$(jget 'd["images"]' <<<"$c")" = 1 ] || fail "context images: $c"
aid=$(curl -fsS "$BASE/v1/projects/$PB12" | jget 'd["orchestrator_agent_id"]')
curl -fsS "$BASE/v1/projects/$PB12/agents/$aid/messages" | python3 -c '
import json,sys
m=json.load(sys.stdin)["messages"][0]["content"]
assert m[0]["type"]=="image" and m[0]["width"]==4 and m[1]["type"]=="text", m' || fail "transcript has no image block"
PBI=$(newproject b12img full ',"models":{"orchestrator":"acp:imager"}')
curl -fsS -X POST "$BASE/v1/projects/$PBI/attachments" -H 'content-type: image/png' --data-binary @"$TMP/pic.png" >/dev/null
post POST "/v1/projects/$PBI/messages" "{\"text\":\"[blocks] look\",\"attachments\":[\"$AID\"]}" >/dev/null; idle "$PBI"
grep -q 'blocks=image:image/png:.*,text' <<<"$(last_text "$PBI")" || fail "the ACP agent did not get an image block: $(last_text "$PBI")"
[ "$(curl -fsS "$BASE/v1/projects/$PBI" | jget 'd["accepts_images"]')" = True ] || fail "accepts_images"
PBN=$(newproject b12noimg full ',"models":{"orchestrator":"acp:scripted"}')
curl -fsS -X POST "$BASE/v1/projects/$PBN/attachments" -H 'content-type: image/png' --data-binary @"$TMP/pic.png" >/dev/null
resp=$(command curl -s -w '\n%{http_code}' -H "Authorization: Bearer $HARNESS_API_TOKEN" -X POST "$BASE/v1/projects/$PBN/messages" -H 'content-type: application/json' -d "{\"text\":\"look\",\"attachments\":[\"$AID\"]}")
[ "$(tail -1 <<<"$resp")" = 422 ] && grep -q images_unsupported <<<"$resp" || fail "no 422 images_unsupported: $resp"
echo "   ok"

echo "== M5 notes with descriptions: 100 notes, the prompt holds an index (descriptions, no bodies), read_note opens a body"
PM5=$(newproject m5)
python3 - "$BASE" "$HARNESS_API_TOKEN" "$PM5" <<'PY' || fail "creating 100 notes failed"
import json, sys, urllib.error, urllib.request
base, token, pid = sys.argv[1:4]
def call(method, path, body=None):
    req = urllib.request.Request(base + path, method=method, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"})
    with urllib.request.urlopen(req) as r:
        return json.load(r)
for i in range(100):
    call("POST", f"/v1/projects/{pid}/notes", {
        "title": f"Topic {i:03d}", "description": f"How topic {i:03d} works and when it matters for the release plan", "tags": [f"area-{i % 5}"],
        "content": f"BODYMARK-{i:03d}\n" + "a long body line that stays out of the prompt\n" * 40})
# Raw Markdown with front matter is accepted too, and a parse error is a 400 naming the line.
n = call("POST", f"/v1/projects/{pid}/notes", {"markdown": "---\ntitle: From markdown\ndescription: Created from a .md file\ntags: [md]\n---\n\n# From markdown\nbody\n"})
assert n["description"] == "Created from a .md file" and n["tags"] == ["md"] and n["markdown"].startswith("---\nid: " + n["id"]), n
try:
    call("POST", f"/v1/projects/{pid}/notes", {"markdown": "---\ntitle: x\npinned: maybe\n---\n"})
    raise SystemExit("a bad front matter was accepted")
except urllib.error.HTTPError as e:
    assert e.code == 400 and "line 3" in e.read().decode(), e.code
PY
lst=$(curl -fsS "$BASE/v1/projects/$PM5/notes")
python3 - "$lst" <<'PY' || fail "notes list wrong"
import json, sys
notes = json.loads(sys.argv[1])["notes"]
assert len(notes) == 101 and all("content" not in n and n["description"] for n in notes), notes[:2]
PY
post POST "/v1/projects/$PM5/messages" '{"text":"[notes: BODYMARK] look at the notes"}' >/dev/null
idle "$PM5"
txt=$(agent_texts "$PM5")
python3 - "$txt" <<'PY' || fail "notes check wrong: $txt"
import re, sys
t = sys.argv[1]
m = re.search(r"index_lines=(\d+) more_line=(\w+) needle_in_prompt=(\w+) read_note=(.*)", t)
assert m, t
n, more, needle, read = int(m.group(1)), m.group(2), m.group(3), m.group(4)
assert 20 <= n < 101, ("index budget", n)
assert more == "true", "no 'N more notes' line"
assert needle == "false", "a note body is in the prompt"
assert read.startswith("# From markdown") and "BODYMARK" not in read, read  # the newest note's body, which only read_note returns
PY
ctx=$(curl -fsS "$BASE/v1/projects/$PM5/context")
python3 - "$ctx" <<'PY' || fail "context report: $ctx"
import json, sys
c = json.loads(sys.argv[1])
notes = [x for x in c["categories"] if x["id"] == "notes"][0]["tokens"]
assert 0 < notes < 2200, notes
PY
# The agent's read was recorded on the note it opened.
python3 - "$(curl -fsS "$BASE/v1/projects/$PM5/notes")" <<'PY' || fail "read not recorded"
import json, sys
notes = json.loads(sys.argv[1])["notes"]
assert sum(n["read_count"] for n in notes) == 1 and [n for n in notes if n["read_count"]][0]["last_read_at"], [n for n in notes if n["read_count"]]
PY
echo "   ok"

echo "== S1 project sessions: new session, resume the old one (the model sees the old context), agent sessions, message, stop"
PS1=$(newproject s1)
cur_session() { curl -fsS "$BASE/v1/projects/$1/sessions?kind=main" | jget '[s["id"] for s in d["sessions"] if s["current"]][0]'; }
session_state() { curl -fsS "$BASE/v1/projects/$1/sessions/$2" | jget 'd["session"]["state"]'; }
is_state() { [ "$(session_state "$1" "$2")" = "$3" ]; }
agents_ge() { [ "$(curl -fsS "$BASE/v1/projects/$1/sessions?kind=agent" | jget 'len(d["sessions"])')" -ge "$2" ]; }
agent_continued() { is_state "$1" "$2" idle && curl -fsS "$BASE/v1/projects/$1/sessions/$2/messages" | grep -q 'follow up' && [ "$(curl -fsS "$BASE/v1/projects/$1/sessions/$2/messages" | jget '[m["role"] for m in d["messages"]][-1]')" = assistant ]; }
last_answer() { curl -fsS "$BASE/v1/projects/$1/sessions/$2" | jget 'd["exchanges"][-1]["answer"]'; }
post POST "/v1/projects/$PS1/messages" '{"text":"[ctx] alpha one"}' >/dev/null; idle "$PS1"
S1A=$(cur_session "$PS1")
# Schema 15: a new session becomes the default only with make_default.
S1B=$(post POST "/v1/projects/$PS1/sessions" '{"title":"Beta","make_default":true}' | jget 'd["session"]["id"]')
[ "$(cur_session "$PS1")" = "$S1B" ] || fail "the new session is not current"
post POST "/v1/projects/$PS1/messages" '{"text":"[ctx] beta two"}' >/dev/null; idle "$PS1"
last_answer "$PS1" "$S1B" | grep -q 'beta two' || fail "the new session's answer lacks its own request"
last_answer "$PS1" "$S1B" | grep -q 'alpha one' && fail "the new session sees the old session's request"
post POST "/v1/projects/$PS1/sessions/$S1A/resume" >/dev/null
[ "$(cur_session "$PS1")" = "$S1A" ] || fail "resume did not make the old session current"
post POST "/v1/projects/$PS1/messages" '{"text":"[ctx] gamma three"}' >/dev/null; idle "$PS1"
ans=$(last_answer "$PS1" "$S1A")
echo "$ans" | grep -q 'alpha one' || fail "the resumed session lost its context: $ans"
echo "$ans" | grep -q 'gamma three' || fail "the resumed session's answer lacks the new request: $ans"
echo "$ans" | grep -q 'beta two' && fail "the resumed session sees the other session's request: $ans"
[ "$(curl -fsS "$BASE/v1/projects/$PS1/sessions/$S1A" | jget 'd["session"]["exchanges"]')" = 2 ] || fail "the resumed session did not take the exchange"
# Agent sessions: one per sub-agent, linked to the session and the turn that spawned it.
post POST "/v1/projects/$PS1/messages" '{"text":"build it"}' >/dev/null; idle "$PS1"
waitfor "agent sessions" agents_ge "$PS1" 3
AS=$(curl -fsS "$BASE/v1/projects/$PS1/sessions?kind=agent" | jget '[s["id"] for s in d["sessions"] if s["title"]=="Map the repository layout"][0]')
curl -fsS "$BASE/v1/projects/$PS1/sessions/$AS" | python3 -c '
import json,sys
d=json.load(sys.stdin); s=d["session"]
assert s["kind"]=="agent" and s["parent_session_id"]=="'"$S1A"'" and s["turn_id"]>0 and s["state"]=="idle" and s["can_message"], s
assert d["agent"]["role"]=="Code explorer", d["agent"]
' || fail "agent session fields"
[ "$(curl -fsS "$BASE/v1/projects/$PS1/sessions/$S1A" | jget 'd["session"]["children"]')" -ge 3 ] || fail "children not counted"
# A message continues the finished built-in agent from its stored messages; report_to_parent hands the answer to the next turn.
out=$(post POST "/v1/projects/$PS1/sessions/$AS/messages" '{"text":"[ctx] follow up","report_to_parent":true}' | jget 'd["outcome"]')
[ "$out" = continued ] || fail "outcome $out"
waitfor "the continued agent" agent_continued "$PS1" "$AS"
sleep 0.5
post POST "/v1/projects/$PS1/messages" '{"text":"[ctx] what came back"}' >/dev/null; idle "$PS1"
last_answer "$PS1" "$S1A" | grep -q 'Results the user collected' || fail "the report did not reach the orchestrator's next turn"
# Schema 15: a main session takes messages on its own route.
[ "$(http_code POST "/v1/projects/$PS1/sessions/$S1B/messages" '{"text":"quick to beta"}')" = 202 ] || fail "message to a main session was refused"
idle "$PS1"
# Stop: an ACP orchestrator's running turn, through its session; /clear of it refuses meanwhile.
PS1A=$(newproject s1a full ',"models":{"orchestrator":"acp:scripted"}')
post POST "/v1/projects/$PS1A/messages" '{"text":"[echo] first"}' >/dev/null; idle "$PS1A"
S1C=$(cur_session "$PS1A")
post POST "/v1/projects/$PS1A/messages" '{"text":"[hang] stuck"}' >/dev/null
waitfor "the ACP turn to run" is_state "$PS1A" "$S1C" working
[ "$(curl -s -X POST "$BASE/v1/projects/$PS1A/clear" | jget 'd["error"]["code"]')" = turn_in_progress ] || fail "clear while running"
[ "$(http_code POST "/v1/projects/$PS1A/sessions/$S1C/stop")" = 200 ] || fail "stop"
idle "$PS1A"
[ "$(curl -fsS "$BASE/v1/projects/$PS1A/sessions/$S1C" | jget 'd["session"]["state"]')" = stopped ] || fail "session not stopped"
[ "$(curl -s -X POST "$BASE/v1/projects/$PS1A/sessions/$S1C/stop" | jget 'd["error"]["code"]')" = not_running ] || fail "second stop"
echo "   ok"

echo "PARITY OK (B1, B2, B3, B4, B5, B6, B7, B11, B12, B13, M5, S1)"
