#!/usr/bin/env bash
# Developer-machine test runner using the Docker Postgres from
# docker/docker-compose.yml.
# (In CI sandboxes without Docker, use `npm run verify` instead.)
set -euo pipefail

cd "$(dirname "$0")/.."
COMPOSE="docker compose -f docker/docker-compose.yml"

echo "[test] ensuring Postgres is up..."
$COMPOSE up -d db
# Wait for health.
for i in $(seq 1 30); do
  if $COMPOSE exec -T db pg_isready -U app -d luvora_dev >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

echo "[test] (re)creating luvora_test database..."
$COMPOSE exec -T db psql -U app -d postgres \
  -c "DROP DATABASE IF EXISTS luvora_test;" \
  -c "CREATE DATABASE luvora_test;"

export NODE_ENV=test
export DATABASE_URL="postgres://app:app@localhost:5432/luvora_test"
export JWT_ACCESS_SECRET="test-access-secret-at-least-16-chars"
export JWT_REFRESH_SECRET="test-refresh-secret-at-least-16-chars"
export BCRYPT_ROUNDS="4"

echo "[test] migrating..."
npm run -w @luvora/backend migrate:up

echo "[test] running tests..."
npm run -w @luvora/backend test
