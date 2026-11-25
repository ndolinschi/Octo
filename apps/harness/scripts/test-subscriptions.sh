#!/usr/bin/env bash
# Live sub-agent runs on vendor subscriptions.
#
#   scripts/test-subscriptions.sh              the original three: copilot grok codex
#   scripts/test-subscriptions.sh codex grok   only these
#   scripts/test-subscriptions.sh all          every agent below
#
# Agents: copilot grok codex claude-code cursor opencode antigravity devin
# droid omp pi. Only the first three have been run by a person; the manifests
# for the rest come from vendor docs and secondary sources (unverified).
# Switches are OCTO_TEST_<ID>=1 (id upper-cased, "-" as "_"), so you can also
# export them yourself and run go test -tags subscription directly.
#
# Each run sends one short task through the vendor's own CLI and so uses a
# little of that plan's quota. An agent whose CLI is missing or logged out is
# skipped with the reason (go test -v prints it). Reads no credential files.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

known=(copilot grok codex claude-code cursor opencode antigravity devin droid omp pi)
agents=("$@")
if [ "${#agents[@]}" -eq 0 ]; then
  agents=(copilot grok codex)
elif [ "${agents[0]}" = "all" ]; then
  agents=("${known[@]}")
fi
for a in "${agents[@]}"; do
  ok=0
  for k in "${known[@]}"; do
    [ "$a" = "$k" ] && ok=1
  done
  if [ "$ok" -ne 1 ]; then
    echo "unknown agent '$a' (${known[*]})" >&2
    exit 2
  fi
  sw="OCTO_TEST_$(printf '%s' "$a" | tr 'a-z-' 'A-Z_')"
  export "$sw=1"
done

exec go test -tags subscription ./internal/orchestrator -run TestSubscriptionAgents -v -count=1 -timeout 25m
