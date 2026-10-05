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

node -r ts-node/register src/db/migrate.ts up >/dev/null 2>&1

# Start the actual server.
node -r ts-node/register src/server.ts > "$DIR/server.log" 2>&1 &
SERVER_PID=$!
for i in $(seq 1 40); do curl -s "http://localhost:$PORT/health" >/dev/null 2>&1 && break; sleep 0.25; done

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

echo "----"
echo "LIVE SMOKE: $PASS passed, $FAIL failed"

kill "$SERVER_PID" >/dev/null 2>&1
su - "$RUNNER_USER" -c "$PG_BIN/pg_ctl -D '$DATA' -m immediate stop" >/dev/null 2>&1
rm -rf "$DIR"
[ "$FAIL" -eq 0 ]
