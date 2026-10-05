#!/usr/bin/env bash
# =============================================================================
# Luvora — PostgreSQL logical restore (Increment 11).
#
# Restores a backup produced by backup-db.sh (custom pg_dump format) into the
# target database. This is a DESTRUCTIVE operation on the target schema, so it
# requires an explicit confirmation unless FORCE=1 is set.
#
# Usage:
#   DATABASE_URL=postgres://user:pass@host:5432/db ./scripts/restore-db.sh BACKUP_FILE
#   FORCE=1 DATABASE_URL=... ./scripts/restore-db.sh BACKUP_FILE   # non-interactive
#
# Security / safety:
#   - Credentials come ONLY from DATABASE_URL (or ~/.pgpass); never hardcoded.
#   - Refuses to run without an explicit confirmation (or FORCE=1) because it
#     overwrites existing objects.
#   - Uses --clean --if-exists so a restore is repeatable, and --no-owner /
#     --no-privileges so it is portable across environments.
#
# After restoring, verify the application with `npm run -w @luvora/backend
# migrate:up` (idempotent) and the readiness probe. See
# docs/DISASTER_RECOVERY.md for the full runbook.
# =============================================================================
set -euo pipefail

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "ERROR: DATABASE_URL is required (target database)" >&2
  exit 2
fi

BACKUP_FILE="${1:-}"
if [[ -z "$BACKUP_FILE" ]]; then
  echo "ERROR: usage: restore-db.sh BACKUP_FILE" >&2
  exit 2
fi
if [[ ! -r "$BACKUP_FILE" ]]; then
  echo "ERROR: backup file not found or unreadable: $BACKUP_FILE" >&2
  exit 2
fi

# Validate the archive before touching the target.
if ! pg_restore -l "$BACKUP_FILE" >/dev/null 2>&1; then
  echo "ERROR: not a valid pg_dump custom-format archive: $BACKUP_FILE" >&2
  exit 1
fi

# Confirmation gate (destructive).
if [[ "${FORCE:-0}" != "1" ]]; then
  # Show only the host/db, never the password embedded in DATABASE_URL.
  SAFE_TARGET="$(printf '%s' "$DATABASE_URL" | sed -E 's#(://[^:/@]+):[^@]*@#\1:***@#')"
  echo "About to RESTORE into: ${SAFE_TARGET}"
  echo "This OVERWRITES existing objects. Type 'yes' to continue:"
  read -r CONFIRM
  if [[ "$CONFIRM" != "yes" ]]; then
    echo "[restore] aborted."
    exit 1
  fi
fi

echo "[restore] restoring ${BACKUP_FILE} ..."

# --clean --if-exists  drop existing objects first (repeatable restore)
# --no-owner / --no-privileges  portability
# --exit-on-error      fail loudly rather than leave a half-restored DB
if ! pg_restore --dbname="$DATABASE_URL" \
      --clean --if-exists \
      --no-owner --no-privileges \
      --exit-on-error \
      "$BACKUP_FILE"; then
  echo "[restore] FAILED" >&2
  exit 1
fi

echo "[restore] OK. Next: run migrations (idempotent) and check /ready."
