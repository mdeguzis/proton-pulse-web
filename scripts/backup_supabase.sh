#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

usage() {
  cat <<'EOF'
Usage: scripts/backup_supabase.sh [--label LABEL] [--output-dir DIR]

Creates a logical backup of the Supabase database using pg_dump:
  - roles.sql   custom cluster roles
  - schema.sql  schema-only dump
  - data.sql    data-only dump with COPY statements

Requires SUPABASE_DB_URL to be set, or a .env file at the repo root
containing SUPABASE_DB_URL.

Environment:
  SUPABASE_DB_URL         Percent-encoded Postgres connection string (required).
  SUPABASE_BACKUP_DIR     Root output directory. Default: data/supabase
  SUPABASE_BACKUP_LABEL   Backup folder name. Default: UTC timestamp

Examples:
  SUPABASE_DB_URL='postgresql://...' scripts/backup_supabase.sh
  scripts/backup_supabase.sh --label nightly
EOF
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "error: required command not found: $1" >&2
    echo "  Install it with: pkg install postgresql" >&2
    exit 1
  fi
}

load_dotenv() {
  local env_file="${REPO_ROOT}/.env"
  if [[ -f "${env_file}" ]]; then
    set -o allexport
    # shellcheck disable=SC1090
    source "${env_file}"
    set +o allexport
  fi
}

backup_label="${SUPABASE_BACKUP_LABEL:-}"
backup_root="${SUPABASE_BACKUP_DIR:-${REPO_ROOT}/data/supabase}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --label)
      backup_label="${2:-}"
      if [[ -z "${backup_label}" ]]; then
        echo "error: --label requires a value" >&2
        exit 1
      fi
      shift 2
      ;;
    --output-dir)
      backup_root="${2:-}"
      if [[ -z "${backup_root}" ]]; then
        echo "error: --output-dir requires a value" >&2
        exit 1
      fi
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "error: unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

require_command pg_dump
require_command tar

load_dotenv

if [[ -z "${SUPABASE_DB_URL:-}" ]]; then
  cat >&2 <<'EOF'
error: SUPABASE_DB_URL is not set.

Set it in your shell or in a .env file at the repo root:

  SUPABASE_DB_URL='postgresql://postgres.[ref]:[password]@aws-0-us-east-1.pooler.supabase.com:6543/postgres'

You can find the connection string in the Supabase dashboard:
  Settings > Database > Connection string > URI (Session mode, port 5432 or 6543)
EOF
  exit 1
fi

if [[ -z "${backup_label}" ]]; then
  backup_label="$(date -u +%Y%m%dT%H%M%SZ)"
fi

if [[ "${backup_root}" != /* ]]; then
  backup_root="${REPO_ROOT}/${backup_root}"
fi

mkdir -p "${backup_root}"

backup_dir="${backup_root}/${backup_label}"
if [[ -e "${backup_dir}" ]]; then
  echo "error: backup output already exists: ${backup_dir}" >&2
  exit 1
fi
mkdir -p "${backup_dir}"

cleanup_backup_dir() {
  if [[ -d "${backup_dir:-}" ]]; then
    rm -rf "${backup_dir}"
  fi
}
trap cleanup_backup_dir ERR

echo "Creating Supabase backup in ${backup_dir}"

echo "==> writing roles.sql"
pg_dump "${SUPABASE_DB_URL}" --roles-only --no-password \
  -f "${backup_dir}/roles.sql"

echo "==> writing schema.sql"
pg_dump "${SUPABASE_DB_URL}" --schema-only --no-password \
  -f "${backup_dir}/schema.sql"

echo "==> writing data.sql"
pg_dump "${SUPABASE_DB_URL}" --data-only --no-password \
  --column-inserts \
  -f "${backup_dir}/data.sql"

cat > "${backup_dir}/manifest.txt" <<EOF
created_at_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)
source_mode=db-url
backup_label=${backup_label}
files=roles.sql,schema.sql,data.sql
EOF

archive_path="${backup_dir}.tar.gz"
tar -C "${backup_root}" -czf "${archive_path}" "${backup_label}"
trap - ERR

echo "Backup complete:"
echo "  directory: ${backup_dir}"
echo "  archive:   ${archive_path}"
