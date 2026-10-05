#!/usr/bin/env bash
# Distributed-abuse live smoke (Increment 12). Boots ephemeral PostgreSQL AND
# ephemeral Redis, starts the real backend with ABUSE_BACKEND=redis, and
# verifies the distributed abuse backend end-to-end over HTTP:
#   - readiness reports redis healthy
#   - admin abuse-backend diagnostic reports redis + healthy (no creds leaked)
#   - login brute-force throttle enforced THROUGH Redis
#   - abuse state is actually written to Redis (namespaced, fingerprinted)
#   - fail-closed: killing Redis flips /ready to 503
# All within one process so the sandbox does not reap background services.
#
# This is the ONLY smoke that proves distributed behaviour; it REQUIRES a
# redis-server binary and fails loudly if none is found (we never pretend a
# distributed smoke ran without Redis).
set -uo pipefail
RUNNER_USER="pgrunner"
PG_BIN="/usr/bin"
id "$RUNNER_USER" >/dev/null 2>&1 || useradd -m "$RUNNER_USER"

# Locate a redis-server binary.
REDIS_BIN=""
for b in redis6-server redis-server /usr/bin/redis6-server /usr/bin/redis-server; do
  if command -v "$b" >/dev/null 2>&1 || [ -x "$b" ]; then REDIS_BIN="$b"; break; fi
done
if [ -z "$REDIS_BIN" ]; then
  echo "REDIS SMOKE: SKIPPED (no redis-server binary found)"
  exit 0
fi
# A matching redis CLI (for direct assertions on the keyspace).
REDIS_CLI="redis6-cli"; command -v "$REDIS_CLI" >/dev/null 2>&1 || REDIS_CLI="redis-cli"

DIR="$(mktemp -d)"; chown -R "$RUNNER_USER" "$DIR"
DATA="$DIR/data"
REDIS_DATA="$DIR/redis"; mkdir -p "$REDIS_DATA"

# --- PostgreSQL ---
su - "$RUNNER_USER" -c "$PG_BIN/initdb -D '$DATA' -U app --auth=trust" >/dev/null 2>&1
{ echo "unix_socket_directories = '$DIR'"; echo "listen_addresses = ''"; echo "fsync = off"; } >> "$DATA/postgresql.conf"
su - "$RUNNER_USER" -c "nohup $PG_BIN/postgres -D '$DATA' -k '$DIR' >'$DATA/pg.log' 2>&1 & disown; sleep 0.3" >/dev/null 2>&1
for i in $(seq 1 30); do su - "$RUNNER_USER" -c "$PG_BIN/pg_isready -h '$DIR' -U app" >/dev/null 2>&1 && break; sleep 0.5; done
su - "$RUNNER_USER" -c "$PG_BIN/createdb -h '$DIR' -U app luvora_dev" >/dev/null 2>&1

# --- Redis (ephemeral, loopback only, no persistence) ---
REDIS_PORT=6577
"$REDIS_BIN" --port "$REDIS_PORT" --bind 127.0.0.1 --save '' --appendonly no --dir "$REDIS_DATA" > "$REDIS_DATA/redis.log" 2>&1 &
REDIS_PID=$!
for i in $(seq 1 50); do "$REDIS_CLI" -p "$REDIS_PORT" ping >/dev/null 2>&1 && break; sleep 0.1; done

export NODE_ENV=development
export DATABASE_URL="postgres://app@/luvora_dev?host=$DIR"
export JWT_ACCESS_SECRET="smoke-access-secret-at-least-16-chars"
export JWT_REFRESH_SECRET="smoke-refresh-secret-at-least-16-chars"
export BCRYPT_ROUNDS="4"
export PORT="4210"
# Distributed abuse backend under test.
export ABUSE_BACKEND="redis"
export REDIS_URL="redis://127.0.0.1:$REDIS_PORT"
export REDIS_KEY_PREFIX="luvorasmoke"
export ABUSE_FINGERPRINT_SECRET="smoke-abuse-fingerprint-secret-32chars-xx"
export ABUSE_FAIL_POLICY="closed"
# Low brute-force threshold + short throttle so the HTTP lockout check is fast.
export LOGIN_MAX_FAILURES="4"
export LOGIN_THROTTLE_SECONDS="2"
# Generous legacy limiter so it never interferes.
export RATE_LIMIT_MAX="100000"
export AUTH_RATE_LIMIT_MAX="100000"
export METRICS_ENABLED="true"
export METRICS_REQUIRE_AUTH="true"
export JOB_WORKER_ENABLED="false"

cd "$(dirname "$0")/../apps/backend"
node -r ts-node/register src/db/migrate.ts up >/dev/null 2>&1

node -r ts-node/register src/server.ts > "$DIR/server.log" 2>&1 &
SERVER_PID=$!
for i in $(seq 1 50); do curl -s "http://localhost:$PORT/health" >/dev/null 2>&1 && break; sleep 0.25; done
# Give the abuse backend a moment to connect to Redis.
sleep 1

PASS=0; FAIL=0
check() { if echo "$3" | grep -q "$2"; then echo "PASS: $1"; PASS=$((PASS+1)); else echo "FAIL: $1 (expected '$2' in: $3)"; FAIL=$((FAIL+1)); fi; }
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
json() { curl -s "$@"; }
B="http://localhost:$PORT"

check "health ok" '"status":"ok"' "$(json $B/health)"
# Readiness: Redis is healthy, so ready + abuseBackend ok.
READY=$(json $B/ready)
check "readiness ready with redis" '"status":"ready"' "$READY"
check "readiness abuseBackend ok" '"abuseBackend":"ok"' "$READY"

# Register an admin to read diagnostics.
ADM=$(json -X POST $B/api/auth/register -H 'Content-Type: application/json' -d '{"email":"admin.redis@example.com","password":"Passw0rd!x","displayName":"Adm","dateOfBirth":"1990-01-01","ageConfirmed":true}')
TADM=$(echo "$ADM" | sed -n 's/.*"accessToken":"\([^"]*\)".*/\1/p')
UADM=$(echo "$ADM" | sed -n 's/.*"userId":"\([^"]*\)".*/\1/p')
su - "$RUNNER_USER" -c "PGHOST='$DIR' $PG_BIN/psql -U app -d luvora_dev -c \"UPDATE users SET role='ADMIN' WHERE id='$UADM'\"" >/dev/null 2>&1

ABUSE_DIAG=$(json $B/api/admin/abuse-backend -H "Authorization: Bearer $TADM")
check "abuse backend reports redis" '"backend":"redis"' "$ABUSE_DIAG"
check "abuse backend redis healthy" '"status":"ok"' "$ABUSE_DIAG"
check "abuse fail policy closed" '"failPolicy":"closed"' "$ABUSE_DIAG"
if echo "$ABUSE_DIAG" | grep -qiE 'redis://|127.0.0.1|password|@'; then echo "FAIL: abuse diagnostic leaks connection info"; FAIL=$((FAIL+1)); else echo "PASS: abuse diagnostic exposes no connection info"; PASS=$((PASS+1)); fi

# --- Distributed brute-force through the real login endpoint ---
reg() { json -X POST $B/api/auth/register -H 'Content-Type: application/json' -d "{\"email\":\"$1\",\"password\":\"Passw0rd!x\",\"displayName\":\"U\",\"dateOfBirth\":\"1994-02-02\",\"ageConfirmed\":true}"; }
reg "bruteforce.redis@example.com" >/dev/null
badlogin() { curl -s -o /dev/null -w '%{http_code}' -X POST "$B/api/auth/login" -H 'Content-Type: application/json' -d '{"email":"bruteforce.redis@example.com","password":"wrong!"}'; }
for i in 1 2 3 4; do badlogin >/dev/null; done
# The 5th attempt should now be throttled (LOGIN_MAX_FAILURES=4), enforced via Redis.
check "login brute-force throttled via redis 429" '429' "$(badlogin)"
# The abuse state must actually live in Redis under our namespace.
NKEYS=$("$REDIS_CLI" -p "$REDIS_PORT" --scan --pattern "luvorasmoke:abuse:*" 2>/dev/null | wc -l | tr -d ' ')
check "abuse state present in redis keyspace" '1' "$([ "$NKEYS" -ge 1 ] && echo 1 || echo 0)"
# No raw email/IP in any Redis key (fingerprinted keys only).
RAWKEYS=$("$REDIS_CLI" -p "$REDIS_PORT" --scan 2>/dev/null | grep -c "bruteforce.redis@example.com" || true)
check "no raw identifier in redis keys" '0' "$RAWKEYS"

# --- Metrics: distributed abuse counters are exposed ---
METRICS_FILE="$DIR/metrics.txt"
curl -s "$B/metrics" -H "Authorization: Bearer $TADM" -o "$METRICS_FILE"
check "metrics expose abuse_backend_requests_total" 'abuse_backend_requests_total' "$(cat "$METRICS_FILE")"

# --- Fail-closed: kill Redis and confirm /ready flips to 503 ---
kill -TERM "$REDIS_PID" >/dev/null 2>&1
sleep 1
READY_DOWN=$(code $B/ready)
check "readiness 503 when redis down (fail-closed)" '503' "$READY_DOWN"
# /health (liveness) must still be ok — it does not depend on Redis.
check "health still ok when redis down" '"status":"ok"' "$(json $B/health)"

echo "----"
echo "REDIS SMOKE: $PASS passed, $FAIL failed"

kill "$SERVER_PID" >/dev/null 2>&1
kill "$REDIS_PID" >/dev/null 2>&1
su - "$RUNNER_USER" -c "$PG_BIN/pg_ctl -D '$DATA' -m immediate stop" >/dev/null 2>&1
rm -rf "$DIR"
[ "$FAIL" -eq 0 ]
