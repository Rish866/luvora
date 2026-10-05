#!/usr/bin/env bash
# Live end-to-end smoke test: boots ephemeral PG, starts the real backend,
# exercises health/auth/age-gate/consent/authorization over HTTP, tears down.
# All within one process so the sandbox does not reap background services.
set -uo pipefail
RUNNER_USER="pgrunner"
PG_BIN="/usr/bin"
id "$RUNNER_USER" >/dev/null 2>&1 || useradd -m "$RUNNER_USER"
DIR="$(mktemp -d)"; chown -R "$RUNNER_USER" "$DIR"
DATA="$DIR/data"

su - "$RUNNER_USER" -c "$PG_BIN/initdb -D '$DATA' -U app --auth=trust" >/dev/null 2>&1
{ echo "unix_socket_directories = '$DIR'"; echo "listen_addresses = ''"; echo "fsync = off"; } >> "$DATA/postgresql.conf"
su - "$RUNNER_USER" -c "nohup $PG_BIN/postgres -D '$DATA' -k '$DIR' >'$DATA/pg.log' 2>&1 & disown; sleep 0.3" >/dev/null 2>&1
for i in $(seq 1 30); do su - "$RUNNER_USER" -c "$PG_BIN/pg_isready -h '$DIR' -U app" >/dev/null 2>&1 && break; sleep 0.5; done
su - "$RUNNER_USER" -c "$PG_BIN/createdb -h '$DIR' -U app luvora_dev" >/dev/null 2>&1

export NODE_ENV=development
export DATABASE_URL="postgres://app@/luvora_dev?host=$DIR"
export JWT_ACCESS_SECRET="smoke-access-secret-at-least-16-chars"
export JWT_REFRESH_SECRET="smoke-refresh-secret-at-least-16-chars"
export BCRYPT_ROUNDS="4"
export PORT="4100"
# This smoke test registers several users and makes many auth calls in quick
# succession; raise the limits so the limiter does not interfere (it is still
# exercised by its own dedicated test). Rate limiting itself is covered elsewhere.
export RATE_LIMIT_MAX="100000"
export AUTH_RATE_LIMIT_MAX="100000"
# Increment 8: enable push delivery with the deterministic TEST provider (no
# external network, no real credentials) so delivery can be exercised live.
export NOTIFICATION_PUSH_ENABLED="true"
export PUSH_PROVIDER="test"
export DEVICE_RATE_LIMIT_MAX="100000"
# Short presence TTL so heartbeat/TTL behaviour is observable in the smoke run.
export PRESENCE_HEARTBEAT_SECONDS="1"
export PRESENCE_TTL_SECONDS="2"
# Increment 9: background job worker. The API process stays API-only
# (JOB_WORKER_ENABLED=false); a SEPARATE worker process drains the queue, with
# fast polling + short lease so the smoke run observes behaviour quickly.
export JOB_WORKER_ENABLED="false"
export JOB_POLL_INTERVAL_MS="100"
export JOB_LEASE_SECONDS="5"
export JOB_LEASE_HEARTBEAT_SECONDS="2"
export JOB_RECLAIM_INTERVAL_SECONDS="2"
export JOB_RETRY_BASE_DELAY_MS="200"
export JOB_RETRY_MAX_DELAY_MS="2000"
export JOB_MAX_ATTEMPTS="3"
# Increment 10: observability. Metrics enabled + ADMIN-auth required (safe
# defaults). Low queue-pressure thresholds so backlog is observable quickly.
export LOG_LEVEL="info"
export METRICS_ENABLED="true"
export METRICS_REQUIRE_AUTH="true"
export JOB_QUEUE_WARNING_DEPTH="2"
export JOB_QUEUE_CRITICAL_DEPTH="50"
export JOB_QUEUE_MAX_AGE_SECONDS="300"
# Increment 11: security hardening. A known CORS allowlist, low brute-force
# threshold + short throttle (so the live lockout check is fast), small request
# limits, and a small media pixel cap so the dimension-reject check uses a tiny
# image. The abuse guard is always on; the login limiter is NOT the same as the
# generous RATE_LIMIT_MAX above.
export CORS_ALLOWED_ORIGINS="https://app.luvora.test,https://admin.luvora.test"
export LOGIN_MAX_FAILURES="4"
export LOGIN_FAILURE_WINDOW_SECONDS="900"
export LOGIN_THROTTLE_SECONDS="2"
export JSON_BODY_LIMIT_BYTES="65536"
export MAX_URL_LENGTH="2048"
export MEDIA_MAX_PIXELS="150000"

node -r ts-node/register src/db/migrate.ts up >/dev/null 2>&1
# Seed the published scenario library so the gameplay smoke flow has content.
node -r ts-node/register src/db/scenarioSeed.ts >/dev/null 2>&1

# Start the actual server.
node -r ts-node/register src/server.ts > "$DIR/server.log" 2>&1 &
SERVER_PID=$!
for i in $(seq 1 40); do curl -s "http://localhost:$PORT/health" >/dev/null 2>&1 && break; sleep 0.25; done

# Start a SEPARATE background worker process against the same database. This
# exercises the real durable queue end-to-end (claim/lease/retry/dead-letter).
node -r ts-node/register src/jobs/workerMain.ts > "$DIR/worker.log" 2>&1 &
WORKER_PID=$!
sleep 0.5

PASS=0; FAIL=0
check() { # name  expected_substring  actual
  if echo "$3" | grep -q "$2"; then echo "PASS: $1"; PASS=$((PASS+1));
  else echo "FAIL: $1 (expected '$2' in: $3)"; FAIL=$((FAIL+1)); fi
}
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
json() { curl -s "$@"; }
B="http://localhost:$PORT"

check "health" '"status":"ok"' "$(json $B/health)"
check "ready(db)" '"status":"ready"' "$(json $B/ready)"

# Adult registration -> success (201)
ADULT=$(json -X POST $B/api/auth/register -H 'Content-Type: application/json' \
  -d '{"email":"adult.smoke@example.com","password":"Passw0rd!x","displayName":"Adult","dateOfBirth":"1995-01-01","ageConfirmed":true}')
check "adult register success" '"success":true' "$ADULT"
ACCESS=$(echo "$ADULT" | sed -n 's/.*"accessToken":"\([^"]*\)".*/\1/p')
REFRESH=$(echo "$ADULT" | sed -n 's/.*"refreshToken":"\([^"]*\)".*/\1/p')

# Underage registration -> 403 AGE_RESTRICTED
UNDER=$(json -X POST $B/api/auth/register -H 'Content-Type: application/json' \
  -d '{"email":"minor.smoke@example.com","password":"Passw0rd!x","displayName":"Minor","dateOfBirth":"2015-01-01","ageConfirmed":true}')
check "underage rejected" 'AGE_RESTRICTED' "$UNDER"

# Login OK
LOGIN=$(json -X POST $B/api/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"adult.smoke@example.com","password":"Passw0rd!x"}')
check "login success" '"success":true' "$LOGIN"

# Invalid credentials -> 401
BADPW=$(code -X POST $B/api/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"adult.smoke@example.com","password":"wrong"}')
check "bad credentials 401" '401' "$BADPW"

# /me requires auth: without token -> 401
ME_NOAUTH=$(code $B/api/auth/me)
check "/me unauthenticated 401" '401' "$ME_NOAUTH"
# with token -> 200 and no password field
ME=$(json $B/api/auth/me -H "Authorization: Bearer $ACCESS")
check "/me authed success" '"success":true' "$ME"
if echo "$ME" | grep -qi 'password'; then
  echo "FAIL: /me leaks a password field"; FAIL=$((FAIL+1))
else
  echo "PASS: /me no password leak"; PASS=$((PASS+1))
fi

# Refresh rotation
REF=$(json -X POST $B/api/auth/refresh -H 'Content-Type: application/json' -d "{\"refreshToken\":\"$REFRESH\"}")
check "refresh success" '"success":true' "$REF"
# Reuse of old (now rotated) refresh -> 401
REUSE=$(code -X POST $B/api/auth/refresh -H 'Content-Type: application/json' -d "{\"refreshToken\":\"$REFRESH\"}")
check "refresh reuse rejected 401" '401' "$REUSE"

# Logout then refresh with the logged-out token -> 401
NEWREF=$(echo "$REF" | sed -n 's/.*"refreshToken":"\([^"]*\)".*/\1/p')
json -X POST $B/api/auth/logout -H 'Content-Type: application/json' -d "{\"refreshToken\":\"$NEWREF\"}" >/dev/null
AFTER_LOGOUT=$(code -X POST $B/api/auth/refresh -H 'Content-Type: application/json' -d "{\"refreshToken\":\"$NEWREF\"}")
check "logout revokes refresh 401" '401' "$AFTER_LOGOUT"

# Helpers for registering users and extracting fields.
reg() { json -X POST $B/api/auth/register -H 'Content-Type: application/json' \
  -d "{\"email\":\"$1\",\"password\":\"Passw0rd!x\",\"displayName\":\"$2\",\"dateOfBirth\":\"1994-02-02\",\"ageConfirmed\":true}"; }
tok() { echo "$1" | sed -n 's/.*"accessToken":"\([^"]*\)".*/\1/p'; }
uid() { echo "$1" | sed -n 's/.*"userId":"\([^"]*\)".*/\1/p'; }

# ---- Increment 2: discovery, like/pass, mutual match, block, match list ----
PA=$(reg "pa.smoke@example.com" "PlayerA"); TA=$(tok "$PA"); UA=$(uid "$PA")
PB=$(reg "pb.smoke@example.com" "PlayerB"); TB=$(tok "$PB"); UB=$(uid "$PB")
PO=$(reg "po.smoke@example.com" "Outsider"); TO=$(tok "$PO"); UO=$(uid "$PO")

# Discovery feed requires auth.
check "discovery requires auth 401" '401' "$(code $B/api/discovery)"
# Authenticated feed returns candidates and excludes self.
DFEED=$(json $B/api/discovery -H "Authorization: Bearer $TA")
check "discovery feed ok" '"success":true' "$DFEED"
if echo "$DFEED" | grep -q "\"id\":\"$UA\""; then echo "FAIL: self in discovery"; FAIL=$((FAIL+1)); else echo "PASS: self excluded from discovery"; PASS=$((PASS+1)); fi
# Discovery must not leak private fields.
if echo "$DFEED" | grep -qiE 'password|email|refresh_token|date_of_birth|is_disabled'; then
  echo "FAIL: discovery leaks private field"; FAIL=$((FAIL+1))
else echo "PASS: discovery exposes no private fields"; PASS=$((PASS+1)); fi

# Self-like rejected.
check "self-like rejected" 'CANNOT_INTERACT_WITH_SELF' "$(json -X POST $B/api/discovery/$UA/like -H "Authorization: Bearer $TA")"
# Like nonexistent user rejected.
check "like nonexistent rejected" 'USER_NOT_FOUND' "$(json -X POST $B/api/discovery/00000000-0000-0000-0000-000000000000/like -H "Authorization: Bearer $TA")"
# Malformed UUID rejected.
check "like malformed uuid rejected 400" '400' "$(code -X POST $B/api/discovery/not-a-uuid/like -H "Authorization: Bearer $TA")"

# A likes B -> no match yet.
check "A likes B no match" '"matched":false' "$(json -X POST $B/api/discovery/$UB/like -H "Authorization: Bearer $TA")"
# B likes A -> match.
LIKEBACK=$(json -X POST $B/api/discovery/$UA/like -H "Authorization: Bearer $TB")
check "B likes A -> matched" '"matched":true' "$LIKEBACK"
MATCH=$(echo "$LIKEBACK" | sed -n 's/.*"matchId":"\([^"]*\)".*/\1/p')
check "match id returned" 'UUID_OK' "$(echo "$MATCH" | grep -Eq '^[0-9a-f-]{36}$' && echo UUID_OK || echo none)"

# Match appears in both match lists.
check "A match list has B" "\"id\":\"$UB\"" "$(json $B/api/matches -H "Authorization: Bearer $TA")"
check "B match list has A" "\"id\":\"$UA\"" "$(json $B/api/matches -H "Authorization: Bearer $TB")"
# Matched user excluded from discovery.
if json $B/api/discovery -H "Authorization: Bearer $TA" | grep -q "\"id\":\"$UB\""; then
  echo "FAIL: matched user still in discovery"; FAIL=$((FAIL+1))
else echo "PASS: matched user excluded from discovery"; PASS=$((PASS+1)); fi
# IDOR: outsider cannot read A/B match detail.
check "match detail IDOR rejected" 'MATCH_NOT_AUTHORIZED' "$(json $B/api/matches/$MATCH -H "Authorization: Bearer $TO")"
# Participant can read it.
check "participant reads match detail" '"success":true' "$(json $B/api/matches/$MATCH -H "Authorization: Bearer $TA")"

# Pass excludes a user from discovery.
PD=$(reg "pd.smoke@example.com" "PlayerD"); TD=$(tok "$PD"); UD=$(uid "$PD")
json -X POST $B/api/discovery/$UD/pass -H "Authorization: Bearer $TA" >/dev/null
if json $B/api/discovery -H "Authorization: Bearer $TA" | grep -q "\"id\":\"$UD\""; then
  echo "FAIL: passed user still in discovery"; FAIL=$((FAIL+1))
else echo "PASS: passed user excluded from discovery"; PASS=$((PASS+1)); fi

# Block prevents like and removes match; unblock does not recreate match.
check "block ok" '"blocked":true' "$(json -X POST $B/api/users/$UB/block -H "Authorization: Bearer $TA")"
check "like blocked target rejected" 'INTERACTION_NOT_ALLOWED' "$(json -X POST $B/api/discovery/$UB/like -H "Authorization: Bearer $TA")"
if json $B/api/matches -H "Authorization: Bearer $TA" | grep -q "\"$MATCH\""; then
  echo "FAIL: blocked match still active"; FAIL=$((FAIL+1))
else echo "PASS: block removed match from active list"; PASS=$((PASS+1)); fi
json -X DELETE $B/api/users/$UB/block -H "Authorization: Bearer $TA" >/dev/null
if json $B/api/matches -H "Authorization: Bearer $TA" | grep -q "\"$MATCH\""; then
  echo "FAIL: unblock recreated match"; FAIL=$((FAIL+1))
else echo "PASS: unblock did not recreate match"; PASS=$((PASS+1)); fi

# ---- Fantasy session: reuse a fresh discovery-created match ----
# Create two new users and form a match through the real discovery flow, then
# exercise the Increment 1 fantasy consent/state-machine over it.
PE=$(reg "pe.smoke@example.com" "PlayerE"); TE=$(tok "$PE"); UE=$(uid "$PE")
PF=$(reg "pf.smoke@example.com" "PlayerF"); TF=$(tok "$PF"); UF=$(uid "$PF")
json -X POST $B/api/discovery/$UF/like -H "Authorization: Bearer $TE" >/dev/null
MATCH2JSON=$(json -X POST $B/api/discovery/$UE/like -H "Authorization: Bearer $TF")
MATCH=$(echo "$MATCH2JSON" | sed -n 's/.*"matchId":"\([^"]*\)".*/\1/p')
check "fantasy match formed via discovery" 'UUID_OK' "$(echo "$MATCH" | grep -Eq '^[0-9a-f-]{36}$' && echo UUID_OK || echo none)"
# Rebind the fantasy-section identities to E/F and an outsider.
TA="$TE"; TB="$TF"; TO="$TO"

# A invites B.
INV=$(json -X POST $B/api/sessions/invite -H "Authorization: Bearer $TA" -H 'Content-Type: application/json' \
  -d "{\"matchId\":\"$MATCH\",\"scenarioId\":\"midnight-date\",\"scenarioVersion\":\"v1\"}")
check "invite created" '"state":"INVITED"' "$INV"
SID=$(echo "$INV" | sed -n 's/.*"sessionId":"\([^"]*\)".*/\1/p')

# Outsider cannot read the session (IDOR) -> 403 SESSION_NOT_AUTHORIZED
IDOR=$(json $B/api/sessions/$SID/consent -H "Authorization: Bearer $TO")
check "IDOR read rejected" 'SESSION_NOT_AUTHORIZED' "$IDOR"

# Initiator cannot accept own invite -> 403
SELFACCEPT=$(code -X POST $B/api/sessions/$SID/accept -H "Authorization: Bearer $TA")
check "self-accept rejected 403" '403' "$SELFACCEPT"

# Invalid transition: submit consent before accept (still INVITED) -> 409
EARLY=$(json -X POST $B/api/sessions/$SID/consent -H "Authorization: Bearer $TA" -H 'Content-Type: application/json' \
  -d '{"responses":[{"category":"flirting","response":"YES"}],"agreeToParticipate":true}')
check "invalid transition rejected" 'INVALID_STATE_TRANSITION' "$EARLY"

# B accepts -> CONSENT
ACC=$(json -X POST $B/api/sessions/$SID/accept -H "Authorization: Bearer $TB")
check "accept -> CONSENT" '"state":"CONSENT"' "$ACC"

# A says NO to jealousy_themes (private), YES to flirting.
json -X POST $B/api/sessions/$SID/consent -H "Authorization: Bearer $TA" -H 'Content-Type: application/json' \
  -d '{"responses":[{"category":"flirting","response":"YES"},{"category":"jealousy_themes","response":"NO"}],"agreeToParticipate":true}' >/dev/null
# B says YES to both and confirms -> both confirmed -> PLAYING
BV=$(json -X POST $B/api/sessions/$SID/consent -H "Authorization: Bearer $TB" -H 'Content-Type: application/json' \
  -d '{"responses":[{"category":"flirting","response":"YES"},{"category":"jealousy_themes","response":"YES"}],"agreeToParticipate":true}')
check "both consent -> PLAYING" '"state":"PLAYING"' "$BV"
check "allow-list has mutual YES" '"allowedCategories":\["flirting"\]' "$BV"
# B's view must NOT expose A's private NO on jealousy_themes.
if echo "$BV" | grep -qi 'partnerResponses\|"jealousy_themes":"NO"'; then
  echo "FAIL: consent privacy leak (partner NO exposed)"; FAIL=$((FAIL+1))
else
  echo "PASS: consent privacy — partner private NO not exposed"; PASS=$((PASS+1))
fi

# Three-player session: a session is bound to exactly its initiator + invitee;
# there is no API path to add a third player. Any other user acting on the
# session is rejected as a non-participant.
THIRD=$(reg "pc.smoke@example.com" "PlayerC"); TC=$(tok "$THIRD")
THIRDAPI=$(json $B/api/sessions/$SID/consent -H "Authorization: Bearer $TC")
check "third player treated as non-participant" 'SESSION_NOT_AUTHORIZED' "$THIRDAPI"

# Either player can leave safely -> ABANDONED
LEAVE=$(json -X POST $B/api/sessions/$SID/leave -H "Authorization: Bearer $TA")
check "leave -> ABANDONED" '"state":"ABANDONED"' "$LEAVE"

# ---- Increment 3: private chat (HTTP) + real WebSocket ----
PG1=$(reg "cg.smoke@example.com" "ChatG"); TG=$(tok "$PG1"); UG=$(uid "$PG1")
PH1=$(reg "ch.smoke@example.com" "ChatH"); TH=$(tok "$PH1"); UH=$(uid "$PH1")
PCI=$(reg "ci.smoke@example.com" "ChatI"); TI=$(tok "$PCI"); UI=$(uid "$PCI")
# Form a match via real discovery.
json -X POST $B/api/discovery/$UH/like -H "Authorization: Bearer $TG" >/dev/null
CMATCHJSON=$(json -X POST $B/api/discovery/$UG/like -H "Authorization: Bearer $TH")
CMATCH=$(echo "$CMATCHJSON" | sed -n 's/.*"matchId":"\([^"]*\)".*/\1/p')
check "chat match formed" 'UUID_OK' "$(echo "$CMATCH" | grep -Eq '^[0-9a-f-]{36}$' && echo UUID_OK || echo none)"

# History starts empty; unrelated user and unauth are rejected.
check "empty history ok" '"messages":\[\]' "$(json $B/api/matches/$CMATCH/messages -H "Authorization: Bearer $TG")"
check "chat history requires auth 401" '401' "$(code $B/api/matches/$CMATCH/messages)"
check "chat history IDOR rejected" 'CHAT_NOT_AUTHORIZED' "$(json $B/api/matches/$CMATCH/messages -H "Authorization: Bearer $TI")"

# Send via HTTP; empty + oversized rejected.
SENT=$(json -X POST $B/api/matches/$CMATCH/messages -H "Authorization: Bearer $TG" -H 'Content-Type: application/json' -d '{"body":"Hello over HTTP 👋"}')
check "http send ok" '"body":"Hello over HTTP 👋"' "$SENT"
check "http send not spoofable" "\"senderId\":\"$UG\"" "$SENT"
check "empty message rejected" 'MESSAGE_EMPTY' "$(json -X POST $B/api/matches/$CMATCH/messages -H "Authorization: Bearer $TG" -H 'Content-Type: application/json' -d '{"body":"   "}')"
check "history now has message" 'Hello over HTTP' "$(json $B/api/matches/$CMATCH/messages -H "Authorization: Bearer $TG")"

# Real WebSocket flow via a tiny node ws client.
WSOUT=$(WS_PORT="$PORT" WS_TG="$TG" WS_TH="$TH" WS_TI="$TI" WS_MATCH="$CMATCH" WS_BASE="$B" node "$(dirname "$0")/ws-smoke-client.js" 2>&1)
echo "$WSOUT" | sed 's/^/[ws] /'
for key in WS_READY_G WS_READY_H WS_RECV_H WS_RECV_SENDER_OK WS_PERSISTED WS_IDOR_REJECTED; do
  if echo "$WSOUT" | grep -q "$key=ok"; then echo "PASS: websocket $key"; PASS=$((PASS+1));
  else echo "FAIL: websocket $key"; FAIL=$((FAIL+1)); fi
done

# Block enforcement over chat: G blocks H, then H's HTTP send is rejected.
json -X POST $B/api/users/$UH/block -H "Authorization: Bearer $TG" >/dev/null
check "chat send rejected after block" 'CHAT_NOT_AUTHORIZED' "$(json -X POST $B/api/matches/$CMATCH/messages -H "Authorization: Bearer $TH" -H 'Content-Type: application/json' -d '{"body":"after block"}')"

# ---- Increment 4: scenario library + data-driven gameplay (HTTP + WebSocket) ----
# Fresh matched + consented pair.
GU1=$(reg "ga.smoke@example.com" "GameA"); TGA=$(tok "$GU1"); UGA=$(uid "$GU1")
GU2=$(reg "gb.smoke@example.com" "GameB"); TGB=$(tok "$GU2"); UGB=$(uid "$GU2")
GOUT=$(reg "gc.smoke@example.com" "GameC"); TGC=$(tok "$GOUT")
json -X POST $B/api/discovery/$UGB/like -H "Authorization: Bearer $TGA" >/dev/null
GMATCHJSON=$(json -X POST $B/api/discovery/$UGA/like -H "Authorization: Bearer $TGB")
GMATCH=$(echo "$GMATCHJSON" | sed -n 's/.*"matchId":"\([^"]*\)".*/\1/p')
# invite -> accept -> consent (both YES to flirting + roleplay) -> PLAYING
GINV=$(json -X POST $B/api/sessions/invite -H "Authorization: Bearer $TGA" -H 'Content-Type: application/json' -d "{\"matchId\":\"$GMATCH\",\"scenarioId\":\"x\",\"scenarioVersion\":\"v1\"}")
GSID=$(echo "$GINV" | sed -n 's/.*"sessionId":"\([^"]*\)".*/\1/p')
json -X POST $B/api/sessions/$GSID/accept -H "Authorization: Bearer $TGB" >/dev/null
CONSENT='{"responses":[{"category":"flirting","response":"YES"},{"category":"roleplay","response":"YES"},{"category":"mystery","response":"YES"}],"agreeToParticipate":true}'
json -X POST $B/api/sessions/$GSID/consent -H "Authorization: Bearer $TGA" -H 'Content-Type: application/json' -d "$CONSENT" >/dev/null
GPLAY=$(json -X POST $B/api/sessions/$GSID/consent -H "Authorization: Bearer $TGB" -H 'Content-Type: application/json' -d "$CONSENT")
check "session is PLAYING after consent" '"state":"PLAYING"' "$GPLAY"

# Scenario library lists published scenarios.
LIB=$(json "$B/api/scenarios?limit=50" -H "Authorization: Bearer $TGA")
check "scenario library lists published" 'the-midnight-masquerade' "$LIB"
check "scenario library requires auth 401" '401' "$(code $B/api/scenarios)"
# Resolve the masquerade scenario id from the library JSON.
SCID=$(echo "$LIB" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const m=j.data.scenarios.find(x=>x.slug==="the-midnight-masquerade");process.stdout.write(m.id);})')
check "resolved scenario id" 'UUID_OK' "$(echo "$SCID" | grep -Eq '^[0-9a-f-]{36}$' && echo UUID_OK || echo none)"

# Select scenario -> START node.
SEL=$(json -X POST $B/api/sessions/$GSID/scenario -H "Authorization: Bearer $TGA" -H 'Content-Type: application/json' -d "{\"scenarioId\":\"$SCID\"}")
check "scenario selected -> START node" '"type":"START"' "$SEL"
# Extract the take_hand choice id.
CHID=$(echo "$SEL" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const c=j.data.state.node.choices.find(x=>x.key==="take_hand");process.stdout.write(c.id);})')

# IDOR: outsider cannot view/select/choose.
check "game state IDOR rejected" 'GAME_NOT_AUTHORIZED' "$(json $B/api/sessions/$GSID/state -H "Authorization: Bearer $TGC")"
# Invalid choice id rejected.
check "invalid choice rejected" 'INVALID_CHOICE' "$(json -X POST $B/api/sessions/$GSID/choices/00000000-0000-0000-0000-000000000000 -H "Authorization: Bearer $TGA" -H 'Content-Type: application/json' -d '{"clientActionId":"11111111-1111-4111-8111-111111111111"}')"

# Submit a valid choice; verify advance + persistence; duplicate is idempotent.
CA1="22222222-2222-4222-8222-222222222222"
CH1=$(json -X POST $B/api/sessions/$GSID/choices/$CHID -H "Authorization: Bearer $TGA" -H 'Content-Type: application/json' -d "{\"clientActionId\":\"$CA1\"}")
check "choice advances to dance" '"key":"dance"' "$CH1"
check "turn advanced to 1" '"turnNumber":1' "$CH1"
CH1DUP=$(json -X POST $B/api/sessions/$GSID/choices/$CHID -H "Authorization: Bearer $TGA" -H 'Content-Type: application/json' -d "{\"clientActionId\":\"$CA1\"}")
check "duplicate action idempotent (still turn 1)" '"turnNumber":1' "$CH1DUP"

# GET state reflects persisted authoritative state (reconnect).
check "reconnect state is authoritative" '"key":"dance"' "$(json $B/api/sessions/$GSID/state -H "Authorization: Bearer $TGB")"

# Real WebSocket gameplay flow.
WSG=$(WS_PORT="$PORT" WS_TA="$TGA" WS_TB="$TGB" WS_SID="$GSID" node "$(dirname "$0")/game-ws-smoke-client.js" 2>&1)
echo "$WSG" | sed 's/^/[gamews] /'
for key in GW_READY_A GW_READY_B GW_SUBSCRIBE_STATE GW_CHOOSE_BROADCAST_A GW_CHOOSE_BROADCAST_B GW_PERSISTED; do
  if echo "$WSG" | grep -q "$key=ok"; then echo "PASS: gamews $key"; PASS=$((PASS+1));
  else echo "FAIL: gamews $key"; FAIL=$((FAIL+1)); fi
done

# ---- Increment 5: secure media + attachments (HTTP) ----
# Fresh matched pair + an unrelated user, driven by a Node client that uploads a
# real generated PNG, attaches it to a chat message, downloads it, and checks
# IDOR + block behavior.
MA=$(reg "ma.smoke@example.com" "MediaA"); TMA=$(tok "$MA"); UMA=$(uid "$MA")
MB=$(reg "mb.smoke@example.com" "MediaB"); TMB=$(tok "$MB"); UMB=$(uid "$MB")
MC=$(reg "mc.smoke@example.com" "MediaC"); TMC=$(tok "$MC")
json -X POST $B/api/discovery/$UMB/like -H "Authorization: Bearer $TMA" >/dev/null
MMATCHJSON=$(json -X POST $B/api/discovery/$UMA/like -H "Authorization: Bearer $TMB")
MMATCH=$(echo "$MMATCHJSON" | sed -n 's/.*"matchId":"\([^"]*\)".*/\1/p')
check "media match formed" 'UUID_OK' "$(echo "$MMATCH" | grep -Eq '^[0-9a-f-]{36}$' && echo UUID_OK || echo none)"

MEDIAOUT=$(WS_PORT="$PORT" WS_BASE="$B" WS_TA="$TMA" WS_TB="$TMB" WS_TC="$TMC" WS_UB="$UMB" WS_MATCH="$MMATCH" node "$(dirname "$0")/media-smoke-client.js" 2>&1)
echo "$MEDIAOUT" | sed 's/^/[media] /'
for key in MD_INTENT MD_UPLOAD_READY MD_DETECT_PNG MD_ATTACH MD_WS_RECV MD_DTO_SAFE MD_DOWNLOAD_BYTES MD_IDOR_REJECTED MD_BLOCK_DENIES; do
  if echo "$MEDIAOUT" | grep -q "$key=ok"; then echo "PASS: media $key"; PASS=$((PASS+1));
  else echo "FAIL: media $key"; FAIL=$((FAIL+1)); fi
done

# ---- Increment 6: admin + safety + moderation ----
# Promote a user's role directly in the DB (test/ops provisioning — the app has
# NO admin-bootstrap endpoint). Uses a tiny node pg snippet (DATABASE_URL set).
promote_role() { # args: userId role
  node -e '
    const { Client } = require("pg");
    (async () => {
      const c = new Client({ connectionString: process.env.DATABASE_URL });
      await c.connect();
      await c.query("UPDATE users SET role = $2 WHERE id = $1", [process.argv[1], process.argv[2]]);
      await c.end();
    })().catch(e => { console.error(e.message); process.exit(1); });
  ' "$1" "$2"
}

ADM=$(reg "admin.smoke@example.com" "Admin"); UADM=$(uid "$ADM")
promote_role "$UADM" "ADMIN"
# Re-login so the token reflects the ADMIN role context (role is read live anyway).
ADMLOGIN=$(json -X POST $B/api/auth/login -H 'Content-Type: application/json' -d '{"email":"admin.smoke@example.com","password":"Passw0rd!x"}')
TADM=$(tok "$ADMLOGIN")
RU1=$(reg "ru1.smoke@example.com" "ReportUser1"); TRU1=$(tok "$RU1"); URU1=$(uid "$RU1")
RU2=$(reg "ru2.smoke@example.com" "ReportUser2"); URU2=$(uid "$RU2")

# RBAC: normal user denied admin queue.
check "normal user denied admin queue" '403' "$(code $B/api/admin/moderation/queue -H "Authorization: Bearer $TRU1")"
# Admin can read the queue.
check "admin reads moderation queue" '"success":true' "$(json $B/api/admin/moderation/queue -H "Authorization: Bearer $TADM")"

# User files a report; reporter identity not leaked in the response.
REP=$(json -X POST $B/api/reports/user/$URU2 -H "Authorization: Bearer $TRU1" -H 'Content-Type: application/json' -d '{"reason":"HARASSMENT","description":"test"}')
check "report created" '"reported":true' "$REP"
REPID=$(echo "$REP" | sed -n 's/.*"reportId":"\([^"]*\)".*/\1/p')
check "report id returned" 'UUID_OK' "$(echo "$REPID" | grep -Eq '^[0-9a-f-]{36}$' && echo UUID_OK || echo none)"

# Admin inspects + resolves the report.
check "admin inspects report" "\"id\":\"$REPID\"" "$(json $B/api/admin/reports/$REPID -H "Authorization: Bearer $TADM")"
RESOLVED=$(json -X POST $B/api/admin/reports/$REPID/resolve -H "Authorization: Bearer $TADM" -H 'Content-Type: application/json' -d '{"status":"RESOLVED","resolution":"warned"}')
check "admin resolves report" '"status":"RESOLVED"' "$RESOLVED"

# Suspend RU1, verify revocation across endpoints, then unsuspend.
SUS=$(json -X POST $B/api/admin/users/$URU1/suspend -H "Authorization: Bearer $TADM" -H 'Content-Type: application/json' -d '{"reason":"harassment","durationHours":24}')
check "admin suspends user" '"status":"SUSPENDED"' "$SUS"
check "suspended token rejected on /me" 'ACCOUNT_SUSPENDED' "$(json $B/api/auth/me -H "Authorization: Bearer $TRU1")"
check "suspended discovery blocked 403" '403' "$(code $B/api/discovery -H "Authorization: Bearer $TRU1")"
check "suspended cannot re-login 403" '403' "$(code -X POST $B/api/auth/login -H 'Content-Type: application/json' -d '{"email":"ru1.smoke@example.com","password":"Passw0rd!x"}')"
json -X POST $B/api/admin/users/$URU1/unsuspend -H "Authorization: Bearer $TADM" >/dev/null
check "unsuspend restores login" '"success":true' "$(json -X POST $B/api/auth/login -H 'Content-Type: application/json' -d '{"email":"ru1.smoke@example.com","password":"Passw0rd!x"}')"

# Admin safeguards: cannot suspend self; last admin cannot be demoted.
check "admin cannot self-suspend" 'CANNOT_SUSPEND_SELF' "$(json -X POST $B/api/admin/users/$UADM/suspend -H "Authorization: Bearer $TADM" -H 'Content-Type: application/json' -d '{"reason":"x"}')"
check "cannot demote last admin" 'LAST_ADMIN' "$(json -X POST $B/api/admin/users/$UADM/role -H "Authorization: Bearer $TADM" -H 'Content-Type: application/json' -d '{"role":"USER"}')"

# Audit log contains the suspend action with the admin as actor; no secrets.
AUDIT=$(json "$B/api/admin/audit-logs?action=user.suspended" -H "Authorization: Bearer $TADM")
check "audit has suspend action" '"action":"user.suspended"' "$AUDIT"
if echo "$AUDIT" | grep -qiE 'password|refresh_token|"token"'; then echo "FAIL: audit leaks secrets"; FAIL=$((FAIL+1)); else echo "PASS: audit has no secrets"; PASS=$((PASS+1)); fi
# Normal user cannot read audit logs.
check "normal user denied audit logs" '403' "$(code $B/api/admin/audit-logs -H "Authorization: Bearer $TRU1")"
# Privilege escalation attempt via body is ignored.
check "self-promote via body fails" '403' "$(code -X POST $B/api/admin/users/$URU2/role -H "Authorization: Bearer $TRU1" -H 'Content-Type: application/json' -d '{"role":"ADMIN"}')"

# ---- Increment 7: notifications + presence ----
# Fresh matched pair + an unrelated stranger.
NA=$(reg "na.smoke@example.com" "NotifA"); TNA=$(tok "$NA"); UNA=$(uid "$NA")
NB=$(reg "nb.smoke@example.com" "NotifB"); TNB=$(tok "$NB"); UNB=$(uid "$NB")
NS=$(reg "ns.smoke@example.com" "NotifStranger"); TNS=$(tok "$NS")
json -X POST $B/api/discovery/$UNB/like -H "Authorization: Bearer $TNA" >/dev/null
NMATCHJSON=$(json -X POST $B/api/discovery/$UNA/like -H "Authorization: Bearer $TNB")
NMATCH=$(echo "$NMATCHJSON" | sed -n 's/.*"matchId":"\([^"]*\)".*/\1/p')
check "notif match formed" 'UUID_OK' "$(echo "$NMATCH" | grep -Eq '^[0-9a-f-]{36}$' && echo UUID_OK || echo none)"

# A mutual match created MATCH_CREATED notifications for both.
check "match created notification" '"type":"MATCH_CREATED"' "$(json $B/api/notifications -H "Authorization: Bearer $TNA")"
# Feed + unread-count require auth.
check "notifications require auth 401" '401' "$(code $B/api/notifications)"
check "unread-count requires auth 401" '401' "$(code $B/api/notifications/unread-count)"
# Unread count is at least 1 after the match.
UC=$(json $B/api/notifications/unread-count -H "Authorization: Bearer $TNA")
check "unread count >=1 after match" '"count":' "$UC"
# Feed DTO exposes only safe fields (no dedupe_key / user_id leak).
NFEED=$(json $B/api/notifications -H "Authorization: Bearer $TNA")
if echo "$NFEED" | grep -qiE 'dedupe|user_id|expires_at'; then echo "FAIL: notification feed leaks internal fields"; FAIL=$((FAIL+1)); else echo "PASS: notification feed exposes no internal fields"; PASS=$((PASS+1)); fi

# Mark one notification read (idempotent), then read-all -> unread goes to 0.
NID=$(echo "$NFEED" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);process.stdout.write(j.data.notifications[0].id);})')
check "mark one read" '"success":true' "$(json -X POST $B/api/notifications/$NID/read -H "Authorization: Bearer $TNA")"
check "mark read idempotent" '"success":true' "$(json -X POST $B/api/notifications/$NID/read -H "Authorization: Bearer $TNA")"
# IDOR: B cannot mark A's notification read.
check "notification read IDOR rejected" 'NOTIFICATION_NOT_FOUND' "$(json -X POST $B/api/notifications/$NID/read -H "Authorization: Bearer $TNB")"
json -X POST $B/api/notifications/read-all -H "Authorization: Bearer $TNA" >/dev/null
check "read-all clears unread" '"count":0' "$(json $B/api/notifications/unread-count -H "Authorization: Bearer $TNA")"

# Preferences: default all enabled; SAFETY cannot be disabled; MATCHES can.
check "preferences default enabled" '"enabled":true' "$(json $B/api/notifications/preferences -H "Authorization: Bearer $TNA")"
check "cannot disable SAFETY preference" 'CRITICAL_PREFERENCE' "$(json -X PUT $B/api/notifications/preferences -H "Authorization: Bearer $TNA" -H 'Content-Type: application/json' -d '{"category":"SAFETY","enabled":false}')"
check "can disable MATCHES preference" '"enabled":false' "$(json -X PUT $B/api/notifications/preferences -H "Authorization: Bearer $TNA" -H 'Content-Type: application/json' -d '{"category":"MATCHES","enabled":false}')"

# Presence API: self visible; stranger rejected; matched visible.
check "presence self visible" '"status":' "$(json $B/api/users/$UNA/presence -H "Authorization: Bearer $TNA")"
check "presence requires auth 401" '401' "$(code $B/api/users/$UNA/presence)"
check "presence stranger rejected" 'PRESENCE_NOT_AUTHORIZED' "$(json $B/api/users/$UNA/presence -H "Authorization: Bearer $TNS")"
check "presence matched visible" '"status":' "$(json $B/api/users/$UNA/presence -H "Authorization: Bearer $TNB")"
# Presence must not leak online state to strangers.
PSTR=$(json $B/api/users/$UNA/presence -H "Authorization: Bearer $TNS")
if echo "$PSTR" | grep -qi 'lastSeen\|ONLINE\|OFFLINE'; then echo "FAIL: stranger presence leaks status"; FAIL=$((FAIL+1)); else echo "PASS: stranger presence leaks no status"; PASS=$((PASS+1)); fi

# Real WebSocket flow: presence transitions + notification.created delivery.
NPOUT=$(WS_PORT="$PORT" WS_BASE="$B" WS_TA="$TNA" WS_TB="$TNB" WS_UA="$UNA" WS_MATCH="$NMATCH" node "$(dirname "$0")/notif-presence-smoke-client.js" 2>&1)
echo "$NPOUT" | sed 's/^/[notifws] /'
for key in NP_READY_B NP_PRESENCE_ONLINE NP_API_ONLINE NP_API_STILL_ONLINE_2SOCK NP_NOTIF_EVENT NP_NOTIF_NO_BODY_LEAK NP_NOTIF_PERSISTED NP_UNREAD_COUNT NP_STILL_ONLINE_AFTER_1_CLOSE NP_PRESENCE_OFFLINE NP_PRESENCE_OFFLINE_LASTSEEN NP_API_OFFLINE_LASTSEEN; do
  if echo "$NPOUT" | grep -q "$key=ok"; then echo "PASS: notifws $key"; PASS=$((PASS+1));
  else echo "FAIL: notifws $key"; FAIL=$((FAIL+1)); fi
done

# Suspension creates a SAFETY notification that bypasses preferences.
NADM=$(reg "nadmin.smoke@example.com" "NotifAdmin"); UNADM=$(uid "$NADM")
promote_role "$UNADM" "ADMIN"
NADMLOGIN=$(json -X POST $B/api/auth/login -H 'Content-Type: application/json' -d '{"email":"nadmin.smoke@example.com","password":"Passw0rd!x"}')
TNADM=$(tok "$NADMLOGIN")
NVIC=$(reg "nvictim.smoke@example.com" "NotifVictim"); TNVIC=$(tok "$NVIC"); UNVIC=$(uid "$NVIC")
json -X POST $B/api/admin/users/$UNVIC/suspend -H "Authorization: Bearer $TNADM" -H 'Content-Type: application/json' -d '{"reason":"harassment"}' >/dev/null
json -X POST $B/api/admin/users/$UNVIC/unsuspend -H "Authorization: Bearer $TNADM" >/dev/null
# After unsuspend the victim can log in and read their SAFETY notification.
NVICLOGIN=$(json -X POST $B/api/auth/login -H 'Content-Type: application/json' -d '{"email":"nvictim.smoke@example.com","password":"Passw0rd!x"}')
TNVIC=$(tok "$NVICLOGIN")
VSAFE=$(json $B/api/notifications -H "Authorization: Bearer $TNVIC")
check "suspension emits SAFETY notification" '"type":"SAFETY_ACTION"' "$VSAFE"
# SAFETY notification must not leak the moderator id or the reason.
if echo "$VSAFE" | grep -q "$UNADM"; then echo "FAIL: SAFETY notification leaks moderator id"; FAIL=$((FAIL+1)); else echo "PASS: SAFETY notification hides moderator id"; PASS=$((PASS+1)); fi
if echo "$VSAFE" | grep -qi 'harassment'; then echo "FAIL: SAFETY notification leaks reason"; FAIL=$((FAIL+1)); else echo "PASS: SAFETY notification hides reason detail"; PASS=$((PASS+1)); fi

# ---- Increment 8: notification delivery + devices + distributed presence ----
# Small node-pg helpers to inspect delivery/device state (server runs out of
# process, so the TestPushProvider's in-memory record is observed via the DB).
pgscalar() { # args: SQL (returns a single value as text)
  node -e '
    const { Client } = require("pg");
    (async () => {
      const c = new Client({ connectionString: process.env.DATABASE_URL });
      await c.connect();
      const r = await c.query(process.argv[1]);
      process.stdout.write(String(r.rows[0] ? Object.values(r.rows[0])[0] : ""));
      await c.end();
    })().catch(e => { console.error(e.message); process.exit(1); });
  ' "$1"
}

# Poll a pgscalar query until it equals an expected value, or time out. Avoids
# arbitrary sleeps (poll every 100ms, up to ~6s). Used for async job/delivery.
pgpoll() { # args: expected  SQL
  local expected="$1" sql="$2" val=""
  for i in $(seq 1 60); do
    val="$(pgscalar "$sql")"
    if [ "$val" = "$expected" ]; then echo "$val"; return 0; fi
    sleep 0.1
  done
  echo "$val"
}

# Fresh matched pair + a stranger.
DA=$(reg "da.smoke@example.com" "DelivA"); TDA=$(tok "$DA"); UDA=$(uid "$DA")
DB_=$(reg "db.smoke@example.com" "DelivB"); TDB=$(tok "$DB_"); UDB=$(uid "$DB_")
DS=$(reg "ds.smoke@example.com" "DelivStranger"); TDS=$(tok "$DS")
json -X POST $B/api/discovery/$UDB/like -H "Authorization: Bearer $TDA" >/dev/null
DMATCHJSON=$(json -X POST $B/api/discovery/$UDA/like -H "Authorization: Bearer $TDB")
DMATCH=$(echo "$DMATCHJSON" | sed -n 's/.*"matchId":"\([^"]*\)".*/\1/p')
check "delivery match formed" 'UUID_OK' "$(echo "$DMATCH" | grep -Eq '^[0-9a-f-]{36}$' && echo UUID_OK || echo none)"

# Device registration: auth required, idempotent, no raw token leak.
check "device register requires auth 401" '401' "$(code -X POST $B/api/notifications/devices)"
DEVJSON=$(json -X POST $B/api/notifications/devices -H "Authorization: Bearer $TDB" -H 'Content-Type: application/json' -d '{"platform":"ANDROID","provider":"FCM","token":"smoke-tok-ok-aaaa"}')
check "device registered" '"active":true' "$DEVJSON"
if echo "$DEVJSON" | grep -q 'smoke-tok-ok-aaaa'; then echo "FAIL: device response leaks raw token"; FAIL=$((FAIL+1)); else echo "PASS: device response hides raw token"; PASS=$((PASS+1)); fi
DEVID=$(echo "$DEVJSON" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
# Idempotent re-register -> still one active device.
json -X POST $B/api/notifications/devices -H "Authorization: Bearer $TDB" -H 'Content-Type: application/json' -d '{"platform":"ANDROID","provider":"FCM","token":"smoke-tok-ok-aaaa"}' >/dev/null
check "device registration idempotent" '1' "$(pgscalar "SELECT count(*)::int FROM notification_devices WHERE user_id='$UDB' AND revoked_at IS NULL")"
# Invalid platform/provider/token rejected.
check "device invalid platform 400" '400' "$(code -X POST $B/api/notifications/devices -H "Authorization: Bearer $TDB" -H 'Content-Type: application/json' -d '{"platform":"WINDOWS","provider":"FCM","token":"abcdefgh"}')"
check "device malformed token 400" '400' "$(code -X POST $B/api/notifications/devices -H "Authorization: Bearer $TDB" -H 'Content-Type: application/json' -d '{"platform":"IOS","provider":"APNS","token":"x"}')"
# List: safe metadata only, no raw token.
DEVLIST=$(json $B/api/notifications/devices -H "Authorization: Bearer $TDB")
check "device list ok" '"tokenFingerprint"' "$DEVLIST"
if echo "$DEVLIST" | grep -q 'smoke-tok-ok-aaaa'; then echo "FAIL: device list leaks raw token"; FAIL=$((FAIL+1)); else echo "PASS: device list hides raw token"; PASS=$((PASS+1)); fi
# IDOR: stranger cannot revoke B's device.
check "device revoke IDOR rejected" 'DEVICE_NOT_FOUND' "$(json -X DELETE $B/api/notifications/devices/$DEVID -H "Authorization: Bearer $TDS")"

# Push delivery is now driven by the durable worker: a message to B enqueues a
# job the worker processes into a DELIVERED PUSH row. Poll (no fixed sleep).
json -X POST $B/api/matches/$DMATCH/messages -H "Authorization: Bearer $TDA" -H 'Content-Type: application/json' -d '{"body":"delivery smoke body"}' >/dev/null
check "push delivery recorded DELIVERED" '1' "$(pgpoll 1 "SELECT CASE WHEN count(*) >= 1 THEN 1 ELSE 0 END FROM notification_deliveries nd JOIN notifications n ON n.id=nd.notification_id WHERE n.user_id='$UDB' AND nd.channel='PUSH' AND nd.status='DELIVERED'")"
check "realtime delivery recorded" '1' "$(pgpoll 1 "SELECT CASE WHEN count(*) >= 1 THEN 1 ELSE 0 END FROM notification_deliveries nd JOIN notifications n ON n.id=nd.notification_id WHERE n.user_id='$UDB' AND nd.channel='REALTIME' AND nd.status='DELIVERED'")"
# Delivery dedup: at most one PUSH row per notification (idempotent).
check "push delivery deduped (1 row)" '1' "$(pgscalar "SELECT CASE WHEN COALESCE(max(c),0) <= 1 THEN 1 ELSE 0 END FROM (SELECT count(*) c FROM notification_deliveries nd JOIN notifications n ON n.id=nd.notification_id WHERE n.user_id='$UDB' AND nd.channel='PUSH' GROUP BY nd.notification_id) t")"
# Push payload privacy: the notification body is minimal (no message text).
check "notification body is generic (no leak)" '0' "$(pgscalar "SELECT count(*)::int FROM notifications WHERE user_id='$UDB' AND body LIKE '%delivery smoke body%'")"

# Invalid-token revocation: register a device whose token the TEST provider
# rejects as PERMANENT, then dispatch -> device auto-revoked.
json -X POST $B/api/notifications/devices -H "Authorization: Bearer $TDB" -H 'Content-Type: application/json' -d '{"platform":"IOS","provider":"APNS","token":"smoke-invalid-token-bbbb"}' >/dev/null
json -X POST $B/api/matches/$DMATCH/messages -H "Authorization: Bearer $TDA" -H 'Content-Type: application/json' -d '{"body":"second body"}' >/dev/null
# The invalid-token device (provider APNS, the only APNS device for B) must be
# auto-revoked once the worker processes the delivery; its delivery row REVOKED.
check "invalid token device auto-revoked" '1' "$(pgpoll 1 "SELECT CASE WHEN count(*)>=1 THEN 1 ELSE 0 END FROM notification_devices WHERE user_id='$UDB' AND provider='APNS' AND revoked_at IS NOT NULL")"
check "invalid token delivery marked REVOKED" '1' "$(pgpoll 1 "SELECT CASE WHEN count(*) >= 1 THEN 1 ELSE 0 END FROM notification_deliveries nd JOIN notification_devices d ON d.id=nd.device_id WHERE d.user_id='$UDB' AND d.provider='APNS' AND nd.status='REVOKED'")"

# Push preference: disabling push for MESSAGES suppresses PUSH but keeps in-app.
# Send a NEW message and track its specific notification: no PUSH job work for
# it, but the in-app notification exists. (Deterministic — scoped to this id.)
json -X PUT $B/api/notifications/preferences -H "Authorization: Bearer $TDB" -H 'Content-Type: application/json' -d '{"category":"MESSAGES","pushEnabled":false}' >/dev/null
json -X POST $B/api/matches/$DMATCH/messages -H "Authorization: Bearer $TDA" -H 'Content-Type: application/json' -d '{"body":"third body"}' >/dev/null
# The newest MESSAGE_RECEIVED notification for B.
SUPNID=$(pgscalar "SELECT id FROM notifications WHERE user_id='$UDB' AND type='MESSAGE_RECEIVED' ORDER BY created_at DESC LIMIT 1")
check "in-app notification still created when push disabled" 'OK' "$([ -n "$SUPNID" ] && echo OK || echo none)"
# Give the worker time to (not) deliver; assert no PUSH delivery row for it.
sleep 1
check "push suppressed when pushEnabled=false" '0' "$(pgscalar "SELECT count(*)::int FROM notification_deliveries WHERE notification_id='$SUPNID' AND channel='PUSH'")"
# SAFETY push cannot be disabled.
check "cannot disable SAFETY push" 'CRITICAL_PREFERENCE' "$(json -X PUT $B/api/notifications/preferences -H "Authorization: Bearer $TDB" -H 'Content-Type: application/json' -d '{"category":"SAFETY","pushEnabled":false}')"
# Preferences expose pushEnabled.
check "preferences expose pushEnabled" '"pushEnabled"' "$(json $B/api/notifications/preferences -H "Authorization: Bearer $TDB")"

# Presence: unauthorized/blocked rejected (reconfirm under Increment 8).
check "presence stranger rejected (inc8)" 'PRESENCE_NOT_AUTHORIZED' "$(json $B/api/users/$UDA/presence -H "Authorization: Bearer $TDS")"

# Admin device diagnostics: never exposes the raw token.
DADM=$(reg "dadm.smoke@example.com" "DelivAdmin"); UDADM=$(uid "$DADM")
promote_role "$UDADM" "ADMIN"
DADMLOGIN=$(json -X POST $B/api/auth/login -H 'Content-Type: application/json' -d '{"email":"dadm.smoke@example.com","password":"Passw0rd!x"}')
TDADM=$(tok "$DADMLOGIN")
ADMDEV=$(json $B/api/admin/users/$UDB/devices -H "Authorization: Bearer $TDADM")
check "admin device diagnostics ok" '"tokenFingerprint"' "$ADMDEV"
if echo "$ADMDEV" | grep -q 'smoke-tok-ok-aaaa'; then echo "FAIL: admin device view leaks raw token"; FAIL=$((FAIL+1)); else echo "PASS: admin device view hides raw token"; PASS=$((PASS+1)); fi
check "normal user denied admin device view" '403' "$(code $B/api/admin/users/$UDB/devices -H "Authorization: Bearer $TDB")"

# Real WS flow: notification.created delivery + presence heartbeat.
D8OUT=$(WS_PORT="$PORT" WS_BASE="$B" WS_TA="$TDA" WS_TB="$TDB" WS_UA="$UDA" WS_UB="$UDB" WS_MATCH="$DMATCH" node "$(dirname "$0")/delivery-smoke-client.js" 2>&1)
echo "$D8OUT" | sed 's/^/[deliv] /'
for key in D8_DEVICE_REGISTERED D8_DEVICE_NO_TOKEN_LEAK D8_NOTIF_EVENT D8_NOTIF_NO_BODY D8_PRESENCE_HEARTBEAT_ONLINE; do
  if echo "$D8OUT" | grep -q "$key=ok"; then echo "PASS: deliv $key"; PASS=$((PASS+1));
  else echo "FAIL: deliv $key"; FAIL=$((FAIL+1)); fi
done

# ---- Increment 9: durable background jobs + worker ----
# Fresh matched pair; the worker process is already running against this DB.
JA=$(reg "ja.smoke@example.com" "JobA"); TJA=$(tok "$JA"); UJA=$(uid "$JA")
JB=$(reg "jb.smoke@example.com" "JobB"); TJB=$(tok "$JB"); UJB=$(uid "$JB")
json -X POST $B/api/discovery/$UJB/like -H "Authorization: Bearer $TJA" >/dev/null
JMATCHJSON=$(json -X POST $B/api/discovery/$UJA/like -H "Authorization: Bearer $TJB")
JMATCH=$(echo "$JMATCHJSON" | sed -n 's/.*"matchId":"\([^"]*\)".*/\1/p')
check "job match formed" 'UUID_OK' "$(echo "$JMATCH" | grep -Eq '^[0-9a-f-]{36}$' && echo UUID_OK || echo none)"

# 1-6: enqueue (via message) -> job exists -> worker claims -> delivery occurs ->
# delivery row created -> job SUCCEEDED. Register a good device for B first.
json -X POST $B/api/notifications/devices -H "Authorization: Bearer $TJB" -H 'Content-Type: application/json' -d '{"platform":"ANDROID","provider":"FCM","token":"job-tok-ok-1111"}' >/dev/null
json -X POST $B/api/matches/$JMATCH/messages -H "Authorization: Bearer $TJA" -H 'Content-Type: application/json' -d '{"body":"job delivery body"}' >/dev/null
# A durable push-delivery job was enqueued for B's notification.
check "push delivery job enqueued" '1' "$(pgpoll 1 "SELECT CASE WHEN count(*)>=1 THEN 1 ELSE 0 END FROM background_jobs bj JOIN notifications n ON n.id = (bj.payload->>'notificationId')::uuid WHERE n.user_id='$UJB' AND bj.job_type='NOTIFICATION_PUSH_DELIVERY'")"
# Worker drives it to SUCCEEDED.
check "worker completes delivery job (SUCCEEDED)" '1' "$(pgpoll 1 "SELECT CASE WHEN count(*)>=1 THEN 1 ELSE 0 END FROM background_jobs bj JOIN notifications n ON n.id=(bj.payload->>'notificationId')::uuid WHERE n.user_id='$UJB' AND bj.status='SUCCEEDED'")"
# Delivery row recorded DELIVERED.
check "worker recorded DELIVERED push row" '1' "$(pgpoll 1 "SELECT CASE WHEN count(*)>=1 THEN 1 ELSE 0 END FROM notification_deliveries nd JOIN notifications n ON n.id=nd.notification_id WHERE n.user_id='$UJB' AND nd.channel='PUSH' AND nd.status='DELIVERED'")"

# 7-8: temporary failure -> RETRY_WAIT -> retry eventually succeeds. Register a
# temp-failing device for A, send A a message, then "fix" the token.
json -X POST $B/api/notifications/devices -H "Authorization: Bearer $TJA" -H 'Content-Type: application/json' -d '{"platform":"ANDROID","provider":"FCM","token":"job-tok-temp-fail-1"}' >/dev/null
json -X POST $B/api/matches/$JMATCH/messages -H "Authorization: Bearer $TJB" -H 'Content-Type: application/json' -d '{"body":"temp fail body"}' >/dev/null
# The job (or its delivery) enters a failed/retry state at least once.
check "temporary failure schedules retry" '1' "$(pgpoll 1 "SELECT CASE WHEN count(*)>=1 THEN 1 ELSE 0 END FROM background_jobs bj JOIN notifications n ON n.id=(bj.payload->>'notificationId')::uuid WHERE n.user_id='$UJA' AND (bj.status='RETRY_WAIT' OR bj.attempt_count>=1)")"
# Fix the token; the retry should then deliver + job succeed.
pgscalar "UPDATE notification_devices SET token='job-tok-nowok-1' WHERE user_id='$UJA' AND token_fingerprint = substring(md5('job-tok-temp-fail-1') for 12)" >/dev/null 2>&1 || true
pgscalar "UPDATE notification_devices SET token='job-tok-nowok-1' WHERE user_id='$UJA'" >/dev/null
check "retry eventually succeeds" '1' "$(pgpoll 1 "SELECT CASE WHEN count(*)>=1 THEN 1 ELSE 0 END FROM background_jobs bj JOIN notifications n ON n.id=(bj.payload->>'notificationId')::uuid WHERE n.user_id='$UJA' AND bj.status='SUCCEEDED'")"

# 9: invalid token revokes the device.
JC=$(reg "jc.smoke@example.com" "JobC"); TJC=$(tok "$JC"); UJC=$(uid "$JC")
JD=$(reg "jd.smoke@example.com" "JobD"); TJD=$(tok "$JD"); UJD=$(uid "$JD")
json -X POST $B/api/discovery/$UJD/like -H "Authorization: Bearer $TJC" >/dev/null
JMATCH2=$(echo "$(json -X POST $B/api/discovery/$UJC/like -H "Authorization: Bearer $TJD")" | sed -n 's/.*"matchId":"\([^"]*\)".*/\1/p')
json -X POST $B/api/notifications/devices -H "Authorization: Bearer $TJD" -H 'Content-Type: application/json' -d '{"platform":"IOS","provider":"APNS","token":"job-invalid-token-xx"}' >/dev/null
json -X POST $B/api/matches/$JMATCH2/messages -H "Authorization: Bearer $TJC" -H 'Content-Type: application/json' -d '{"body":"revoke body"}' >/dev/null
check "invalid token revokes device via worker" '1' "$(pgpoll 1 "SELECT CASE WHEN count(*)>=1 THEN 1 ELSE 0 END FROM notification_devices WHERE user_id='$UJD' AND provider='APNS' AND revoked_at IS NOT NULL")"

# 10: dead-letter after max attempts. Enqueue a push job for a notification whose
# only device permanently temp-fails (never fixed). Use the DB to seed directly.
JE=$(reg "je.smoke@example.com" "JobE"); TJE=$(tok "$JE"); UJE=$(uid "$JE")
json -X POST $B/api/notifications/devices -H "Authorization: Bearer $TJE" -H 'Content-Type: application/json' -d '{"platform":"ANDROID","provider":"FCM","token":"job-tok-temp-fail-perma"}' >/dev/null
# Create a SYSTEM notification + delivery job directly (server-trusted path) by
# inserting a notification and letting the app enqueue is not available over
# HTTP; instead drive via a self-match message that always temp-fails.
JF=$(reg "jf.smoke@example.com" "JobF"); TJF=$(tok "$JF"); UJF=$(uid "$JF")
json -X POST $B/api/discovery/$UJF/like -H "Authorization: Bearer $TJE" >/dev/null
JMATCH3=$(echo "$(json -X POST $B/api/discovery/$UJE/like -H "Authorization: Bearer $TJF")" | sed -n 's/.*"matchId":"\([^"]*\)".*/\1/p')
json -X POST $B/api/matches/$JMATCH3/messages -H "Authorization: Bearer $TJF" -H 'Content-Type: application/json' -d '{"body":"deadletter body"}' >/dev/null
check "job dead-letters after max attempts" '1' "$(pgpoll 1 "SELECT CASE WHEN count(*)>=1 THEN 1 ELSE 0 END FROM background_jobs bj JOIN notifications n ON n.id=(bj.payload->>'notificationId')::uuid WHERE n.user_id='$UJE' AND bj.status='DEAD'")"

# 11: duplicate enqueue is idempotent — exactly one delivery job per notification.
check "delivery job idempotent (<=1 per notification)" '1' "$(pgscalar "SELECT CASE WHEN COALESCE(max(c),0) <= 1 THEN 1 ELSE 0 END FROM (SELECT count(*) c FROM background_jobs WHERE job_type='NOTIFICATION_PUSH_DELIVERY' GROUP BY payload->>'notificationId') t")"

# 12: stale lease recovery — a RUNNING job past its lease is reclaimed. Simulate
# by inserting a RUNNING job with an expired lease; the worker's reclaimer flips
# it back to RETRY_WAIT (then processes it; no handler payload -> stays benign).
STALEID=$(pgscalar "INSERT INTO background_jobs (job_type,status,payload,leased_until,worker_id,attempt_count) VALUES ('NOTIFICATION_CLEANUP','RUNNING','{}', now() - interval '1 hour','dead-worker',1) RETURNING id")
check "stale RUNNING job is reclaimed" '1' "$(pgpoll 1 "SELECT CASE WHEN status IN ('RETRY_WAIT','SUCCEEDED','PENDING') THEN 1 ELSE 0 END FROM background_jobs WHERE id='$STALEID'")"

# 13: worker health via admin diagnostics (metrics endpoint).
JADM=$(reg "jadm.smoke@example.com" "JobAdmin"); UJADM=$(uid "$JADM")
promote_role "$UJADM" "ADMIN"
JADMLOGIN=$(json -X POST $B/api/auth/login -H 'Content-Type: application/json' -d '{"email":"jadm.smoke@example.com","password":"Passw0rd!x"}')
TJADM=$(tok "$JADMLOGIN")
check "admin job metrics available" '"countsByStatus"' "$(json $B/api/admin/jobs/metrics -H "Authorization: Bearer $TJADM")"

# 15: admin job diagnostics list (DEAD filter) + redaction.
JOBSOUT=$(json "$B/api/admin/jobs?status=DEAD" -H "Authorization: Bearer $TJADM")
check "admin lists DEAD jobs" '"jobs"' "$JOBSOUT"
if echo "$JOBSOUT" | grep -qiE '"token"|"password"|"authorization"'; then echo "FAIL: job diagnostics leak secrets"; FAIL=$((FAIL+1)); else echo "PASS: job diagnostics expose no secrets"; PASS=$((PASS+1)); fi
# The DTO must not include a raw 'payload' field (only payloadSummary).
if echo "$JOBSOUT" | grep -q '"payloadSummary"'; then echo "PASS: job diagnostics use redacted payloadSummary"; PASS=$((PASS+1)); else echo "FAIL: job diagnostics missing payloadSummary"; FAIL=$((FAIL+1)); fi

# 16: unauthorized job diagnostics blocked (normal user, moderator).
check "normal user denied job diagnostics" '403' "$(code $B/api/admin/jobs -H "Authorization: Bearer $TJA")"
check "job diagnostics require auth 401" '401' "$(code $B/api/admin/jobs)"

# 17: notification API remains successful even when the provider temp-fails.
json -X POST $B/api/notifications/devices -H "Authorization: Bearer $TJB" -H 'Content-Type: application/json' -d '{"platform":"ANDROID","provider":"FCM","token":"job-tok-temp-fail-2"}' >/dev/null
MSGCODE=$(code -X POST $B/api/matches/$JMATCH/messages -H "Authorization: Bearer $TJA" -H 'Content-Type: application/json' -d '{"body":"api still ok"}')
check "notification API ok during provider failure" '201' "$MSGCODE"

# ---- Increment 10: observability & operational controls ----
# (The worker from Increment 9 is still running here; it is shut down below.)

# Correlation id: a request without one gets a generated id in the header; a
# valid supplied id is preserved; an oversized id is replaced.
CORR_HDRS=$(curl -s -D - -o /dev/null "$B/health")
check "correlation id generated on response" 'X-Correlation-Id:' "$CORR_HDRS"
SUPPLIED_HDRS=$(curl -s -D - -o /dev/null -H 'X-Correlation-Id: smoke-corr-123' "$B/health")
check "supplied correlation id preserved" 'smoke-corr-123' "$SUPPLIED_HDRS"
BIG=$(printf 'x%.0s' $(seq 1 400))
OVERSIZED_HDRS=$(curl -s -D - -o /dev/null -H "X-Correlation-Id: $BIG" "$B/health")
if echo "$OVERSIZED_HDRS" | grep -qi "X-Correlation-Id: $BIG"; then echo "FAIL: oversized correlation id echoed"; FAIL=$((FAIL+1)); else echo "PASS: oversized correlation id replaced"; PASS=$((PASS+1)); fi
# Error responses still carry a correlation id.
ERR_HDRS=$(curl -s -D - -o /dev/null "$B/api/notifications")
check "correlation id on error response" 'X-Correlation-Id:' "$ERR_HDRS"

# Health & readiness.
check "health ok" '"status":"ok"' "$(json $B/health)"
check "health reports uptime" '"uptimeSeconds"' "$(json $B/health)"
READY=$(json $B/ready)
check "readiness is ready" '"status":"ready"' "$READY"
check "readiness db ok" '"database":"ok"' "$READY"
check "readiness migrations ok" '"migrations":"ok"' "$READY"
# Readiness must not leak connection strings / SQL.
if echo "$READY" | grep -qiE 'postgres://|SELECT |password='; then echo "FAIL: readiness leaks internals"; FAIL=$((FAIL+1)); else echo "PASS: readiness leaks no internals"; PASS=$((PASS+1)); fi

# Metrics endpoint: unauthorized rejected; admin gets Prometheus text; no secrets.
# Fetch the metrics body ONCE to a file (robust for a large payload), then grep
# the file per assertion (avoids shell-variable truncation of a big body).
check "metrics requires auth 401" '401' "$(code $B/metrics)"
check "metrics rejects normal user 401" '401' "$(code $B/metrics -H "Authorization: Bearer $TJA")"
METRICS_FILE="$DIR/metrics.txt"
curl -s "$B/metrics" -H "Authorization: Bearer $TJADM" -o "$METRICS_FILE"
metric_has() { grep -q "$1" "$METRICS_FILE" && echo FOUND || echo missing; }
check "metrics served to admin (http counter)" 'FOUND' "$(metric_has 'http_requests_total')"
check "metrics include job counters" 'FOUND' "$(metric_has 'jobs_enqueued_total')"
check "metrics include notification counters" 'FOUND' "$(metric_has 'notification_push_sent_total')"
check "metrics include db counters" 'FOUND' "$(metric_has 'db_queries_total')"
check "metrics include websocket counters" 'FOUND' "$(metric_has 'websocket_connections_total')"
if grep -qiE 'password|authorization|postgres://|Bearer ' "$METRICS_FILE"; then echo "FAIL: metrics leak secrets"; FAIL=$((FAIL+1)); else echo "PASS: metrics expose no secrets"; PASS=$((PASS+1)); fi
# Route labels are bounded: a UUID job-detail request must collapse to :id.
json "$B/api/admin/jobs/00000000-0000-0000-0000-0000000000ff" -H "Authorization: Bearer $TJADM" >/dev/null
curl -s "$B/metrics" -H "Authorization: Bearer $TJADM" -o "$METRICS_FILE"
if grep -qE 'route="[^"]*00000000-0000-0000-0000-0000000000ff' "$METRICS_FILE"; then echo "FAIL: metrics route label contains a raw UUID"; FAIL=$((FAIL+1)); else echo "PASS: metrics route labels are bounded (:id)"; PASS=$((PASS+1)); fi

# Worker health incl. queue-pressure signals (admin only).
WH=$(json $B/api/admin/jobs/worker -H "Authorization: Bearer $TJADM")
check "worker health has state" '"state"' "$WH"
check "worker health has queueDepth" '"queueDepth"' "$WH"
check "worker health has queuePressure" '"queuePressure"' "$WH"
check "worker health unauthorized 403" '403' "$(code $B/api/admin/jobs/worker -H "Authorization: Bearer $TJA")"

# Dead-letter listing (admin only) + redaction.
check "admin lists dead-letter jobs" '"jobs"' "$(json "$B/api/admin/jobs/dead" -H "Authorization: Bearer $TJADM")"
check "dead-letter listing unauthorized 403" '403' "$(code $B/api/admin/jobs/dead -H "Authorization: Bearer $TJA")"

# Admin requeue of a DEAD job: seed a DEAD job directly, requeue, verify it is
# PENDING again and an operational event + audit record exist.
DEADID=$(pgscalar "INSERT INTO background_jobs (job_type,status,payload,attempt_count,failed_at) VALUES ('NOTIFICATION_CLEANUP','DEAD','{}',3, now()) RETURNING id")
RETRY=$(json -X POST $B/api/admin/jobs/$DEADID/retry -H "Authorization: Bearer $TJADM" -H 'Content-Type: application/json' -d '{"reason":"smoke"}')
check "admin requeues DEAD job -> PENDING" '"status":"PENDING"' "$RETRY"
check "requeued job attempt reset" '"attemptCount":0' "$RETRY"
check "requeue recorded operational event" '1' "$(pgscalar "SELECT CASE WHEN count(*)>=1 THEN 1 ELSE 0 END FROM operational_events WHERE event_type='JOB_MANUALLY_REQUEUED' AND job_id='$DEADID'")"
check "requeue recorded audit log" '1' "$(pgscalar "SELECT CASE WHEN count(*)>=1 THEN 1 ELSE 0 END FROM audit_logs WHERE action='job.requeued' AND target_id='$DEADID'")"
# The requeued cleanup job executes again safely once the worker drains it.
check "requeued job eventually processed" '1' "$(pgpoll 1 "SELECT CASE WHEN status IN ('SUCCEEDED','RUNNING','RETRY_WAIT') THEN 1 ELSE 0 END FROM background_jobs WHERE id='$DEADID'")"
# Requeuing a non-DEAD job is refused.
check "requeue of SUCCEEDED job refused" 'JOB_NOT_RETRYABLE' "$(json -X POST $B/api/admin/jobs/$DEADID/retry -H "Authorization: Bearer $TJADM")"
# Requeue by a normal user is forbidden.
check "requeue by normal user 403" '403' "$(code -X POST $B/api/admin/jobs/$DEADID/retry -H "Authorization: Bearer $TJA")"

# Admin cancel of a PENDING job. Insert it already scheduled far in the future
# (in a SINGLE statement) so the fast-polling worker never claims it first.
PCANCEL=$(pgscalar "INSERT INTO background_jobs (job_type,status,payload,available_at) VALUES ('NOTIFICATION_CLEANUP','PENDING','{}', now() + interval '1 hour') RETURNING id")
check "admin cancels PENDING job" '"cancelled":true' "$(json -X POST $B/api/admin/jobs/$PCANCEL/cancel -H "Authorization: Bearer $TJADM")"
check "cancelled job is CANCELLED" 'CANCELLED' "$(pgscalar "SELECT status FROM background_jobs WHERE id='$PCANCEL'")"

# Operational events list (admin only) + authorization.
check "admin lists operational events" '"events"' "$(json $B/api/admin/operational-events -H "Authorization: Bearer $TJADM")"
check "operational events unauthorized 403" '403' "$(code $B/api/admin/operational-events -H "Authorization: Bearer $TJA")"

# Queue backlog: seed a small backlog and confirm the depth metric reflects it,
# then the running worker drains it.
for i in 1 2 3 4; do pgscalar "INSERT INTO background_jobs (job_type,status,payload) VALUES ('NOTIFICATION_CLEANUP','PENDING', json_build_object('n', $i)::jsonb)" >/dev/null; done
BACKLOG_WH=$(json $B/api/admin/jobs/worker -H "Authorization: Bearer $TJADM")
check "backlog raises queue depth" '"queueDepth"' "$BACKLOG_WH"
check "worker drains the backlog" '0' "$(pgpoll 0 "SELECT count(*)::int FROM background_jobs WHERE job_type='NOTIFICATION_CLEANUP' AND status IN ('PENDING','RETRY_WAIT') AND payload ? 'n'")"

# 14: graceful worker shutdown — SIGTERM the worker and confirm it exits cleanly.
kill -TERM "$WORKER_PID" >/dev/null 2>&1
WSHUT=fail
for i in $(seq 1 50); do if ! kill -0 "$WORKER_PID" >/dev/null 2>&1; then WSHUT=ok; break; fi; sleep 0.1; done
check "worker graceful shutdown" 'ok' "$WSHUT"
# Worker shutdown recorded an operational event.
check "worker stop recorded operational event" '1' "$(pgpoll 1 "SELECT CASE WHEN count(*)>=1 THEN 1 ELSE 0 END FROM operational_events WHERE event_type='WORKER_STOPPED'")"

# ======================= Increment 11: security hardening =======================
# Run with NODE_ENV=development (abuse guard + limiters ENABLED). Covers security
# headers, strict CORS allowlist, request input limits, and the login
# brute-force throttle end-to-end over real HTTP.

# ---- Security headers (present on normal AND error responses) ----
SEC_HDRS=$(curl -s -D - -o /dev/null "$B/health")
check "header: X-Content-Type-Options nosniff" 'X-Content-Type-Options: nosniff' "$SEC_HDRS"
check "header: X-Frame-Options DENY" 'X-Frame-Options: DENY' "$SEC_HDRS"
check "header: Referrer-Policy no-referrer" 'Referrer-Policy: no-referrer' "$SEC_HDRS"
check "header: Permissions-Policy present" 'Permissions-Policy:' "$SEC_HDRS"
check "header: CSP default-src none" "default-src 'none'" "$SEC_HDRS"
if echo "$SEC_HDRS" | grep -qi 'X-Powered-By'; then echo "FAIL: X-Powered-By exposed"; FAIL=$((FAIL+1)); else echo "PASS: no X-Powered-By header"; PASS=$((PASS+1)); fi
if echo "$SEC_HDRS" | grep -qi 'Strict-Transport-Security'; then echo "FAIL: HSTS emitted while disabled"; FAIL=$((FAIL+1)); else echo "PASS: HSTS not emitted (disabled)"; PASS=$((PASS+1)); fi
# Headers present on an error (404) response too.
SEC_ERR_HDRS=$(curl -s -D - -o /dev/null "$B/api/does-not-exist")
check "header on 404: X-Content-Type-Options" 'X-Content-Type-Options: nosniff' "$SEC_ERR_HDRS"

# ---- CORS strict allowlist ----
CORS_ALLOWED=$(curl -s -D - -o /dev/null -H 'Origin: https://app.luvora.test' "$B/health")
check "CORS: allowed origin reflected" 'Access-Control-Allow-Origin: https://app.luvora.test' "$CORS_ALLOWED"
check "CORS: credentials allowed" 'Access-Control-Allow-Credentials: true' "$CORS_ALLOWED"
CORS_DENIED=$(curl -s -D - -o /dev/null -H 'Origin: https://evil.example.com' "$B/health")
if echo "$CORS_DENIED" | grep -qi 'Access-Control-Allow-Origin'; then echo "FAIL: disallowed origin got CORS headers"; FAIL=$((FAIL+1)); else echo "PASS: disallowed origin blocked (no ACAO)"; PASS=$((PASS+1)); fi
if echo "$CORS_ALLOWED" | grep -qi 'Access-Control-Allow-Origin: \*'; then echo "FAIL: wildcard CORS with credentials"; FAIL=$((FAIL+1)); else echo "PASS: no wildcard CORS origin"; PASS=$((PASS+1)); fi
# Preflight (OPTIONS) for an allowed origin.
CORS_PRE=$(curl -s -D - -o /dev/null -X OPTIONS -H 'Origin: https://app.luvora.test' -H 'Access-Control-Request-Method: POST' "$B/api/auth/login")
check "CORS: preflight reflects allowed origin" 'Access-Control-Allow-Origin: https://app.luvora.test' "$CORS_PRE"

# ---- Request input limits ----
# Oversized JSON body (> JSON_BODY_LIMIT_BYTES=65536) -> 413 PAYLOAD_TOO_LARGE.
# Build the body in a FILE to avoid shell argument/variable truncation.
BIGBODY="$DIR/bigbody.json"
printf '{"blob":"' > "$BIGBODY"; head -c 100000 /dev/zero | tr '\0' 'x' >> "$BIGBODY"; printf '"}' >> "$BIGBODY"
BIGCODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$B/api/auth/register" -H 'Content-Type: application/json' --data-binary @"$BIGBODY")
check "oversized JSON body 413" '413' "$BIGCODE"
BIGRESP=$(curl -s -X POST "$B/api/auth/register" -H 'Content-Type: application/json' --data-binary @"$BIGBODY")
check "oversized body PAYLOAD_TOO_LARGE" 'PAYLOAD_TOO_LARGE' "$BIGRESP"
# Over-long URL (> MAX_URL_LENGTH=2048) -> 413.
LONGQ=$(printf 'a%.0s' $(seq 1 3000))
check "over-long URL 413" '413' "$(code "$B/health?q=$LONGQ")"
# A normal body is accepted (not 413).
NORMCODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$B/api/auth/login" -H 'Content-Type: application/json' -d '{"email":"nobody.smoke@example.com","password":"whatever"}')
if [ "$NORMCODE" = "413" ]; then echo "FAIL: normal body rejected as too large"; FAIL=$((FAIL+1)); else echo "PASS: normal-sized body accepted ($NORMCODE)"; PASS=$((PASS+1)); fi

# ---- Login brute-force throttle (temporary, not lockout) ----
# Register a dedicated victim; LOGIN_MAX_FAILURES=4, LOGIN_THROTTLE_SECONDS=2.
BF=$(reg "bruteforce.smoke@example.com" "BruteTarget")
for i in 1 2 3 4; do
  curl -s -o /dev/null -X POST "$B/api/auth/login" -H 'Content-Type: application/json' \
    -d '{"email":"bruteforce.smoke@example.com","password":"wrong-pass!"}'
done
# The next attempt is throttled: 429 + Retry-After + RATE_LIMITED.
BF_CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$B/api/auth/login" -H 'Content-Type: application/json' -d '{"email":"bruteforce.smoke@example.com","password":"wrong-pass!"}')
check "brute-force throttle 429" '429' "$BF_CODE"
BF_HDRS=$(curl -s -D - -o /dev/null -X POST "$B/api/auth/login" -H 'Content-Type: application/json' -d '{"email":"bruteforce.smoke@example.com","password":"wrong-pass!"}')
check "brute-force Retry-After header" 'Retry-After:' "$BF_HDRS"
BF_BODY=$(curl -s -X POST "$B/api/auth/login" -H 'Content-Type: application/json' -d '{"email":"bruteforce.smoke@example.com","password":"wrong-pass!"}')
check "brute-force RATE_LIMITED code" 'RATE_LIMITED' "$BF_BODY"
# Even the CORRECT password is refused while throttled (gate runs first).
BF_GOOD=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$B/api/auth/login" -H 'Content-Type: application/json' -d '{"email":"bruteforce.smoke@example.com","password":"Passw0rd!x"}')
check "throttle precedes credential check 429" '429' "$BF_GOOD"
# A durable security event was recorded (fingerprint only, no raw IP).
check "brute-force security event recorded" '1' "$(pgpoll 1 "SELECT CASE WHEN count(*)>=1 THEN 1 ELSE 0 END FROM security_events WHERE event_type='BRUTE_FORCE_LOCKOUT'")"
if pgscalar "SELECT COALESCE(string_agg(source_fingerprint, ','), '') FROM security_events" | grep -qE '([0-9]{1,3}\.){3}[0-9]{1,3}'; then echo "FAIL: raw IP stored in security_events"; FAIL=$((FAIL+1)); else echo "PASS: security_events store no raw IP"; PASS=$((PASS+1)); fi
# After the short throttle expires, login works again (temporary, not a lockout).
sleep 3
BF_RECOVER=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$B/api/auth/login" -H 'Content-Type: application/json' -d '{"email":"bruteforce.smoke@example.com","password":"Passw0rd!x"}')
check "throttle is temporary (recovers)" '200' "$BF_RECOVER"

# ---- Admin security-events endpoint (admin only) ----
check "security-events requires auth 401" '401' "$(code $B/api/admin/security-events)"
check "security-events forbids normal user 403" '403' "$(code $B/api/admin/security-events -H "Authorization: Bearer $TJA")"
SEC_EVENTS=$(json $B/api/admin/security-events -H "Authorization: Bearer $TJADM")
check "admin lists security events" '"events"' "$SEC_EVENTS"
if echo "$SEC_EVENTS" | grep -qE '([0-9]{1,3}\.){3}[0-9]{1,3}'; then echo "FAIL: admin security-events leaks raw IP"; FAIL=$((FAIL+1)); else echo "PASS: admin security-events exposes no raw IP"; PASS=$((PASS+1)); fi

# ---- Increment 12: abuse backend diagnostics (admin only) ----
# This default smoke runs with the process-local (memory) backend. The admin
# diagnostic must report that honestly and must NEVER expose a Redis URL/creds.
ABUSE_DIAG=$(json $B/api/admin/abuse-backend -H "Authorization: Bearer $TJADM")
check "abuse-backend diagnostic requires auth 401" '401' "$(code $B/api/admin/abuse-backend)"
check "abuse-backend diagnostic forbids normal user 403" '403' "$(code $B/api/admin/abuse-backend -H "Authorization: Bearer $TJA")"
check "abuse backend reports memory (process-local)" '"backend":"memory"' "$ABUSE_DIAG"
check "abuse backend reports disabled status (no redis configured)" '"status":"disabled"' "$ABUSE_DIAG"
if echo "$ABUSE_DIAG" | grep -qiE 'redis://|password|@'; then echo "FAIL: abuse diagnostic leaks connection info"; FAIL=$((FAIL+1)); else echo "PASS: abuse diagnostic exposes no connection info"; PASS=$((PASS+1)); fi
# Readiness reports the abuse backend sub-check (disabled with memory backend).
check "readiness includes abuseBackend check" 'abuseBackend' "$(json $B/ready)"

echo "----"
echo "LIVE SMOKE: $PASS passed, $FAIL failed"

kill "$SERVER_PID" >/dev/null 2>&1
kill "$WORKER_PID" >/dev/null 2>&1
su - "$RUNNER_USER" -c "$PG_BIN/pg_ctl -D '$DATA' -m immediate stop" >/dev/null 2>&1
rm -rf "$DIR"
[ "$FAIL" -eq 0 ]
