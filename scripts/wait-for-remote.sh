#!/usr/bin/env bash
# Wait for the current branch on origin to reflect the local HEAD before
# triggering a workflow dispatch, preventing race conditions where the runner
# checks out a stale SHA.
#
# Usage: bash scripts/wait-for-remote.sh [max_attempts] [sleep_seconds]
#   max_attempts  default 10
#   sleep_seconds default 3

set -euo pipefail

MAX=${1:-10}
SLEEP=${2:-3}

branch=$(git rev-parse --abbrev-ref HEAD)
local_sha=$(git rev-parse HEAD)
echo "Waiting for origin/$branch to reflect $local_sha..."

for i in $(seq 1 "$MAX"); do
    remote_sha=$(git ls-remote origin "refs/heads/$branch" | cut -f1)
    if [ "$remote_sha" = "$local_sha" ]; then
        echo "origin/$branch matches HEAD ($local_sha). OK."
        exit 0
    fi
    echo "  attempt $i/$MAX: remote has $remote_sha, retrying in ${SLEEP}s..."
    sleep "$SLEEP"
done

remote_sha=$(git ls-remote origin "refs/heads/$branch" | cut -f1)
if [ "$remote_sha" != "$local_sha" ]; then
    echo "error: origin/$branch ($remote_sha) still does not match HEAD ($local_sha) after $MAX attempts." >&2
    echo "Push your changes first: git push origin $branch" >&2
    exit 1
fi
