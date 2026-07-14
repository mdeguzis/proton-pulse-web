#!/usr/bin/env bash
# Post a status-page announcement to Discord. Called by
# .github/workflows/announce-discord.yml when a repo issue gets the
# "announcement" label. Reads WEBHOOK, TITLE, BODY, URL from the environment
# so no secret is ever written into the workflow or this script.
set -euo pipefail

: "${WEBHOOK:?DISCORD_ANNOUNCE_WEBHOOK is not set}"
: "${TITLE:?TITLE is not set}"
: "${URL:?URL is not set}"

content="**${TITLE}**
${URL}

${BODY:-}"

# Discord's hard content limit is 2000 chars; trim with headroom.
content=${content:0:1900}

jq -n --arg c "$content" '{content: $c}' \
  | curl -sS -X POST -H "Content-Type: application/json" -d @- "$WEBHOOK" \
      -w '\nHTTP %{http_code}\n'
