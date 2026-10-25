#!/usr/bin/env bash
# DSH S1 spike — end-to-end run.
#
#   ./spike/run-spike.sh [node-exec]
#
# Builds the extension host + main host, then runs the spike against
# `spike/profile` (the DSH profile contract: extensions.json + extensions-trust.json).
set -euo pipefail
cd "$(dirname "$0")/.."

NODE_EXEC="${1:-${DSH_NODE_EXEC:-$(command -v node)}}"

echo "== build =="
node spike/gen-stub-returns.mjs
node spike/build.mjs

echo "== run (node exec: $NODE_EXEC) =="
node dist/main-host.js spike/profile
