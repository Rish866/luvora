#!/usr/bin/env bash
# =============================================================================
# Luvora — PostgreSQL logical backup (Increment 11).
#
# Takes a consistent, compressed logical backup of the database using the
# custom `pg_dump` format (-Fc), which restore-db.sh consumes via pg_restore.
#
# Usage:
#   DATABASE_URL=postgres://user:pass@host:5432/db ./scripts/backup-db.sh [OUT_DIR]
#
#   OUT_DIR  Directory to write the dump into (default: ./backups).
#
# Security / safety:
#   - Credentials come ONLY from DATABASE_URL (or a standard ~/.pgpass). This
#     script NEVER hardcodes or echoes a password.
#   - The dump file is created with a restrictive umask (owner-only).
#   - Exits non-zero on any failure so a scheduler/CI can detect it.
#
# This produces a point-in-time logical snapshot. For stricter RPO, pair it with
# PostgreSQL WAL archiving / PITR (see docs/DISASTER_RECOVERY.md). It is NOT a
# substitute for a managed provider's continuous backups.
# =============================================================================
set -euo pipefail

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "ERROR: DATABASE_URL is required (e.g. postgres://user:pass@host:5432/db)" >&2
  exit 2
fi

OUT_DIR="${1:-./backups}"
mkdir -p "$OUT_DIR"

# Owner-only permissions on anything we create.
umask 077

TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT_FILE="${OUT_DIR}/luvora-${TIMESTAMP}.dump"

echo "[backup] starting logical backup -> ${OUT_FILE}" >&2

# -Fc  custom format (compressed, selective restore)
# -Z 6 moderate compression
# --no-owner / --no-privileges keep the dump portable across environments.
if ! pg_dump --dbname="$DATABASE_URL" \
      -Fc -Z 6 \
      --no-owner --no-privileges \
      --file="$OUT_FILE"; then
  echo "[backup] FAILED" >&2
  rm -f "$OUT_FILE"
  exit 1
fi

# Basic integrity sanity check: pg_restore -l must list the archive TOC.
if ! pg_restore -l "$OUT_FILE" >/dev/null 2>&1; then
  echo "[backup] integrity check FAILED (archive not readable)" >&2
  exit 1
fi

SIZE="$(wc -c < "$OUT_FILE" | tr -d ' ')"
echo "[backup] OK: ${OUT_FILE} (${SIZE} bytes)" >&2
# stdout carries ONLY the backup path, so callers can capture it cleanly.
echo "$OUT_FILE"
