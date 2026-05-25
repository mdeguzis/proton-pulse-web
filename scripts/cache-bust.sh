#!/usr/bin/env bash
# cache-bust.sh - update the ?v= cache buster in app.html to match app.js content
# called by `make build`
set -euo pipefail

HASH=$(md5sum app.js | cut -c1-9)
OLD=$(grep -oP 'app\.js\?v=\K[a-f0-9]+' app.html || echo "")

if [ "$HASH" = "$OLD" ]; then
  echo "app.html already has ?v=$HASH -- nothing to do."
else
  sed -i "s|app\.js?v=[a-f0-9]*|app.js?v=$HASH|g" app.html
  echo "Updated app.html cache buster to ?v=$HASH (was ${OLD:-none})."
fi
