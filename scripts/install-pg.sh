#!/usr/bin/env bash
set -euo pipefail

# Install pg_dump if missing. Supports Termux (pkg), Debian (apt-get), macOS (brew).

if command -v pg_dump >/dev/null 2>&1; then
    echo "pg_dump already installed: $(pg_dump --version)"
    exit 0
fi

if command -v pkg >/dev/null 2>&1; then
    echo "Installing postgresql via pkg..."
    pkg install -y postgresql
elif command -v apt-get >/dev/null 2>&1; then
    echo "Installing postgresql-client via apt-get..."
    sudo apt-get install -y postgresql-client
elif command -v brew >/dev/null 2>&1; then
    # libpq ships client tools only (no server) but is keg-only, so force-link
    # to get pg_dump on PATH
    echo "Installing libpq via brew..."
    brew install libpq
    brew link --force libpq
else
    echo "error: cannot auto-install pg_dump. Install postgresql-client manually." >&2
    exit 1
fi

pg_dump --version
