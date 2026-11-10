#!/usr/bin/env bash
# Live sub-agent runs on vendor subscriptions (Copilot, Grok, Codex).
#
#   scripts/test-subscriptions.sh              all three
#   scripts/test-subscriptions.sh codex grok   only these
#
# Each run sends one short task through the vendor's own CLI and so uses a
# little of that plan's quota. An agent whose CLI is missing or logged out is
# skipped with the reason (go test -v prints it). Reads no credential files.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

agents=("$@")
if [ "${#agents[@]}" -eq 0 ]; then
  agents=(copilot grok codex)
fi
for a in "${agents[@]}"; do
  case "$a" in
    copilot) export OCTO_TEST_COPILOT=1 ;;
    grok) export OCTO_TEST_GROK=1 ;;
    codex) export OCTO_TEST_CODEX=1 ;;
    *) echo "unknown agent '$a' (copilot, grok or codex)" >&2; exit 2 ;;
  esac
done

exec go test -tags subscription ./internal/orchestrator -run TestSubscriptionAgents -v -count=1 -timeout 25m
