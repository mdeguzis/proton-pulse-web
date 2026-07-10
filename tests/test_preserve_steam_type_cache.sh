#!/usr/bin/env bash
# Test for scripts/preserve-steam-type-cache.sh (#263).
#
# Verifies that the helper reads steam-type-cache.json from the local
# origin/gh-pages ref and re-applies its types to search-index.json in
# the deploy directory. Uses a self-contained git repo as the "remote"
# so nothing hits the network.
set -euo pipefail

SCRIPT="$(cd "$(dirname "$0")/.." && pwd)/scripts/preserve-steam-type-cache.sh"
SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT

# --- Fake upstream gh-pages ---
mkdir "$SCRATCH/upstream"
cd "$SCRATCH/upstream"
git init --bare -q

mkdir "$SCRATCH/upstream-work"
cd "$SCRATCH/upstream-work"
git init -q
git config user.name test
git config user.email test@test
git checkout -q -b gh-pages
cat > steam-type-cache.json <<EOF
{
  "570": "game",
  "413410": "dlc",
  "620980": "mod",
  "440": null
}
EOF
git add . && git commit -q -m init
git remote add origin "$SCRATCH/upstream"
git push -q origin gh-pages

# --- Fake local repo with the script installed ---
mkdir "$SCRATCH/repo"
cp "$SCRIPT" "$SCRATCH/repo"
mkdir "$SCRATCH/repo/scripts"
cp "$SCRIPT" "$SCRATCH/repo/scripts/preserve-steam-type-cache.sh"
chmod +x "$SCRATCH/repo/scripts/preserve-steam-type-cache.sh"
cd "$SCRATCH/repo"
git init -q
git config user.name test
git config user.email test@test
git remote add origin "$SCRATCH/upstream"
git commit -q --allow-empty -m init

# --- Fake deploy dir with a fresh (unenriched) search-index ---
mkdir "$SCRATCH/deploy"
cat > "$SCRATCH/deploy/search-index.json" <<'EOF'
[["570","Dota 2","platinum",100,0,"steam"],["413410","Some DLC","",0,0,"steam"],["620980","Some Mod","",0,0,"steam"],["440","TF2","platinum",50,0,"steam"],["gog:1","GOG Game","gold",5,0,"gog"]]
EOF

# --- Run + assert ---
bash "$SCRATCH/repo/scripts/preserve-steam-type-cache.sh" "$SCRATCH/deploy"

# The deploy dir should now hold the cache file...
test -f "$SCRATCH/deploy/steam-type-cache.json" || { echo "FAIL: cache not copied"; exit 1; }

# ...and search-index.json should have column 11 populated for the cached types.
python3 - "$SCRATCH/deploy" <<'PY'
import json, sys, os
deploy = sys.argv[1]
with open(f"{deploy}/search-index.json") as f:
    rows = json.load(f)
ids = {r[0]: (r[11] if len(r) > 11 else None) for r in rows}
assert ids["570"] == "game", ids
assert ids["413410"] == "dlc", ids
assert ids["620980"] == "mod", ids
# None cached => search-index stays without a column 11 entry (row shorter than 12)
assert ids["440"] is None, ids
# Non-steam rows are untouched, no column 11
assert ids["gog:1"] is None, ids
print("PASS")
PY

# --- Second scenario: no cache upstream, script should be a no-op ---
cd "$SCRATCH/upstream-work"
rm steam-type-cache.json
git add -A && git commit -q -m "wipe cache"
git push -q origin gh-pages

mkdir "$SCRATCH/deploy2"
cat > "$SCRATCH/deploy2/search-index.json" <<'EOF'
[["1","x","gold",1,0,"steam"]]
EOF
bash "$SCRATCH/repo/scripts/preserve-steam-type-cache.sh" "$SCRATCH/deploy2"
test ! -f "$SCRATCH/deploy2/steam-type-cache.json" || { echo "FAIL: script wrote cache when upstream had none"; exit 1; }
python3 - "$SCRATCH/deploy2" <<'PY'
import json, sys
rows = json.load(open(f"{sys.argv[1]}/search-index.json"))
assert len(rows[0]) == 6, rows[0]
print("PASS (no-op case)")
PY

echo "OK: preserve-steam-type-cache.sh tests passed"
