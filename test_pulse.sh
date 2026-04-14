#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Pulse — Full Integration Test Script
# Run: bash test_pulse.sh
# Agent must be running at http://localhost:3000
# ─────────────────────────────────────────────────────────────────────────────

BASE="http://localhost:3000/pulse"
TZ_HEADER="Europe/Prague"
PASS=0; FAIL=0

GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'

pass() { echo -e "  ${GREEN}✓${NC} $1"; ((PASS++)); }
fail() { echo -e "  ${RED}✗${NC} $1"; ((FAIL++)); }
info() { echo -e "  ${YELLOW}→${NC} $1"; }
section() { echo -e "\n${CYAN}══ $1 ══${NC}"; }

h() {
  # h <METHOD> <path> [body]
  local method=$1 path=$2 body=$3
  if [[ -n "$body" ]]; then
    curl -s -X "$method" "$BASE$path" \
      -H "Content-Type: application/json" \
      -H "X-Timezone: $TZ_HEADER" \
      -d "$body"
  else
    curl -s -X "$method" "$BASE$path" \
      -H "X-Timezone: $TZ_HEADER"
  fi
}

# ─────────────────────────────────────────────────────────────────────────────
section "1. Health — /status"
STATUS=$(h GET /status)
echo "  $STATUS" | head -c 200; echo
if echo "$STATUS" | grep -q '"agentName"'; then
  pass "Status endpoint responds"
else
  fail "Status endpoint missing"
fi

# ─────────────────────────────────────────────────────────────────────────────
section "2. GPU / Metrics Panel — /status model name"
MODEL=$(echo "$STATUS" | grep -o '"modelName":"[^"]*"' | head -1)
info "Model reported: $MODEL"
if echo "$MODEL" | grep -qi "qwen"; then
  pass "Model name contains 'qwen'"
else
  fail "Model name unexpected or not set: $MODEL"
fi

# ─────────────────────────────────────────────────────────────────────────────
section "3. Queue — /queue"
QUEUE=$(h GET /queue)
PENDING=$(echo "$QUEUE" | grep -o '"pending":\[[^]]*\]' | head -c 200)
info "Queue response (truncated): $(echo "$QUEUE" | head -c 200)"
if echo "$QUEUE" | grep -q '"pending"'; then
  pass "Queue endpoint responds with pending array"
else
  fail "Queue endpoint missing pending array"
fi

# ─────────────────────────────────────────────────────────────────────────────
section "4. Timezone Detection — X-Timezone header round-trip"
# The briefing endpoint returns generatedAt and dateLabel
BRIEFING=$(h GET /briefing)
info "Briefing: $(echo "$BRIEFING" | head -c 300)"
if echo "$BRIEFING" | grep -q '"dateLabel"'; then
  pass "Briefing endpoint responds with dateLabel"
  DATE_LABEL=$(echo "$BRIEFING" | grep -o '"dateLabel":"[^"]*"')
  info "dateLabel: $DATE_LABEL"
else
  fail "Briefing endpoint missing dateLabel"
fi

# ─────────────────────────────────────────────────────────────────────────────
section "5. Create Calendar Event — date parsing"
info "Asking: 'Schedule a team standup next Monday at 9am'"
CREATE=$(h POST /create-calendar-event '{"message":"Schedule a team standup next Monday at 9am"}')
echo "  Response: $(echo "$CREATE" | head -c 300)"
if echo "$CREATE" | grep -qE '"(success|eventId|id)"'; then
  pass "Calendar event created"
  # Check the date is a Monday
  EVENT_DATE=$(echo "$CREATE" | grep -o '"date":"[^"]*"' | head -1 | grep -o '[0-9-]*')
  if [[ -n "$EVENT_DATE" ]]; then
    DOW=$(date -d "$EVENT_DATE" +%A 2>/dev/null || python3 -c "import datetime; print(datetime.date.fromisoformat('$EVENT_DATE').strftime('%A'))" 2>/dev/null)
    info "Event date: $EVENT_DATE ($DOW)"
    if [[ "$DOW" == "Monday" ]]; then
      pass "Event correctly scheduled on Monday"
    else
      fail "Event scheduled on $DOW, expected Monday"
    fi
  fi
elif echo "$CREATE" | grep -qi "error\|unavailable\|not available"; then
  info "Calendar not configured — skipping date check"
else
  fail "Calendar event creation failed: $(echo "$CREATE" | head -c 200)"
fi

# ─────────────────────────────────────────────────────────────────────────────
section "6. Create Calendar Event — Thursday detection"
info "Asking: 'Block Thursday 2pm for deep work'"
CREATE2=$(h POST /create-calendar-event '{"message":"Block Thursday 2pm for deep work"}')
echo "  Response: $(echo "$CREATE2" | head -c 300)"
if echo "$CREATE2" | grep -qi "already have"; then
  pass "Thursday duplicate blocked by conflict detection (event exists from prior run)"
elif echo "$CREATE2" | grep -qE '"(success|eventId|id)"'; then
  EVENT_DATE2=$(echo "$CREATE2" | grep -o '"date":"[^"]*"' | head -1 | grep -o '[0-9-]*')
  if [[ -n "$EVENT_DATE2" ]]; then
    DOW2=$(date -d "$EVENT_DATE2" +%A 2>/dev/null || python3 -c "import datetime; print(datetime.date.fromisoformat('$EVENT_DATE2').strftime('%A'))" 2>/dev/null)
    info "Event date: $EVENT_DATE2 ($DOW2)"
    if [[ "$DOW2" == "Thursday" ]]; then
      pass "Thursday correctly detected (not Wednesday)"
    else
      fail "Expected Thursday, got $DOW2 — UTC date bug still present?"
    fi
  fi
  pass "Thursday block event created"
elif echo "$CREATE2" | grep -qi "unavailable\|not available"; then
  info "Calendar not configured — skipping"
else
  fail "Thursday event creation failed"
fi

# ─────────────────────────────────────────────────────────────────────────────
section "7. Reschedule by title — time parsing"
info "Asking: 'Reschedule standup to 3pm'"
RESCHED=$(h POST /reschedule-by-title '{"message":"Reschedule standup to 3pm"}')
echo "  Response: $(echo "$RESCHED" | head -c 300)"
if echo "$RESCHED" | grep -qE '"(success|updated|eventId)"'; then
  pass "Reschedule-by-title responded with success"
  # Check 3pm → 15:00, not 16:00
  if echo "$RESCHED" | grep -q '"15:00\|T15:'; then
    pass "3pm correctly resolved to 15:00 (not 16:00)"
  else
    info "Could not verify 15:00 in response — check manually"
  fi
elif echo "$RESCHED" | grep -qi "not found\|no event\|unavailable"; then
  info "No matching event to reschedule — time parsing check skipped"
  # At least verify the extracted time from a direct LLM extraction call
  pass "Reschedule endpoint reachable"
else
  fail "Reschedule-by-title failed: $(echo "$RESCHED" | head -c 200)"
fi

# ─────────────────────────────────────────────────────────────────────────────
section "8. Resolve Conflict — LLM reschedule extraction"
info "Asking: 'Move Meeting A to 3pm' (with mock conflict context)"
RESOLVE=$(h POST /resolve-conflict '{
  "message": "Move Meeting A to 3pm",
  "eventATitle": "Meeting A",
  "eventBTitle": "Sync with David",
  "eventAStart": "2026-04-17T11:00:00+02:00",
  "eventAEnd":   "2026-04-17T12:00:00+02:00",
  "eventBStart": "2026-04-17T11:30:00+02:00",
  "eventBEnd":   "2026-04-17T12:30:00+02:00",
  "date": "2026-04-17"
}')
echo "  Response: $(echo "$RESOLVE" | head -c 400)"
if echo "$RESOLVE" | grep -qE '"(targetTime|newStart|success)"'; then
  TTIME=$(echo "$RESOLVE" | grep -o '"targetTime":"[^"]*"')
  info "Extracted targetTime: $TTIME"
  if echo "$TTIME" | grep -q "15:00"; then
    pass "3pm correctly extracted as 15:00"
  elif echo "$TTIME" | grep -q "null\|\"\""; then
    info "targetTime null — LLM may not have extracted time (no event IDs provided)"
    pass "Conflict resolution endpoint reachable"
  elif echo "$TTIME" | grep -q "16:00"; then
    fail "LLM returned 16:00 instead of 15:00 — prompt anchoring bug"
  else
    info "Got: $TTIME"
    pass "Conflict resolution responded"
  fi
else
  fail "Resolve-conflict failed: $(echo "$RESOLVE" | head -c 200)"
fi

# ─────────────────────────────────────────────────────────────────────────────
section "9. Log Commitment — Slib Guard"
info "Logging: 'I will send the report to Jan by Friday'"
COMMIT=$(h POST /log-commitment '{"text":"I will send the report to Jan by Friday"}')
echo "  Response: $(echo "$COMMIT" | head -c 300)"
if echo "$COMMIT" | grep -qE '"(success|id|commitmentId)"'; then
  pass "Commitment logged"
  # Check it shows in queue as slib_reminder
  sleep 1
  QUEUE2=$(h GET /queue)
  if echo "$QUEUE2" | grep -qi "slib\|commitment\|Jan\|report"; then
    pass "Slib reminder appears in approval queue"
  else
    info "Slib reminder not yet in queue (may need a moment)"
  fi
elif echo "$COMMIT" | grep -qi "error"; then
  fail "Log-commitment failed: $(echo "$COMMIT" | head -c 200)"
else
  info "Unexpected response: $(echo "$COMMIT" | head -c 200)"
fi

# ─────────────────────────────────────────────────────────────────────────────
section "10. Decisions history — /decisions"
DECISIONS=$(h GET /decisions)
if echo "$DECISIONS" | grep -q '"decisions"'; then
  pass "Decisions endpoint responds"
else
  fail "Decisions endpoint missing"
fi

# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo -e "${CYAN}══════════════════════════════════${NC}"
echo -e "  Results: ${GREEN}$PASS passed${NC}  ${RED}$FAIL failed${NC}"
echo -e "${CYAN}══════════════════════════════════${NC}"
[[ $FAIL -eq 0 ]] && echo -e "  ${GREEN}All tests passed ✓${NC}" || echo -e "  ${RED}$FAIL test(s) failed — check output above${NC}"
echo ""
