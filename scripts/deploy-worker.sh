#!/usr/bin/env bash
set -euo pipefail

# Deploy a Cloudflare Worker from workers/<name>/ via wrangler.
#
# Usage:
#   scripts/deploy-worker.sh [worker]
#
# `worker` is a directory name under workers/ that contains a wrangler.toml.
# Defaults to edge-status (the status-page health check worker, #275).
#
# Auth: relies on a prior `npx wrangler login`. The KV namespace id lives in
# the worker's wrangler.toml and secrets are set separately with
# `npx wrangler secret put`, so this only redeploys code + config.

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKER="${1:-edge-status}"
WORKER_DIR="$REPO_ROOT/workers/$WORKER"

if [ ! -d "$WORKER_DIR" ]; then
  echo "ERROR: no such worker dir: workers/$WORKER" >&2
  echo "Available workers:" >&2
  find "$REPO_ROOT/workers" -maxdepth 2 -name wrangler.toml -printf '  %h\n' 2>/dev/null | sed "s#$REPO_ROOT/workers/##" >&2
  exit 1
fi

if [ ! -f "$WORKER_DIR/wrangler.toml" ]; then
  echo "ERROR: workers/$WORKER has no wrangler.toml (only folder-based workers are supported)" >&2
  exit 1
fi

echo "Deploying worker '$WORKER' from workers/$WORKER ..."
cd "$WORKER_DIR"
npx wrangler deploy
echo "Deployed worker '$WORKER'."
