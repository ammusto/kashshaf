#!/usr/bin/env bash
# Post-deploy smoke test: the server is up, pointed at real data, and
# compatible with both old and new clients.
#
#   bash smoke.sh http://127.0.0.1:3000 0.5.0
#   bash smoke.sh https://api.kashshaf.com 0.5.0
#
# Checks (any failure → exit 1):
#   /health                       status ok, version == expected, warm_cache complete|disabled
#   /search?q=قال&mode=lemma      total_hits > 0, elapsed_ms < 500
#   /search/proximity الله ~10 قال total_hits > 0, elapsed_ms < 2000, rows present
#   /search/wildcard?q=ابن ال*    total_hits > 0, elapsed_ms < 3000
#   /page/tokens without part_index  HTTP 200 (0.4.x compatibility shim)
#   /search/status?key=<walk_key> HTTP 200 for the proximity walk
#   a burst of 60 requests        at least one 429 with a JSON {"error": ...} body
#                                 (skipped with a note when the limiter is off:
#                                 KASHSHAF_SMOKE_RATE_LIMIT=0)
set -uo pipefail

BASE="${1:?usage: smoke.sh <base-url> <expected-version>}"
EXPECTED="${2:?usage: smoke.sh <base-url> <expected-version>}"
EXPECT_429="${KASHSHAF_SMOKE_RATE_LIMIT:-1}"
FAIL=0

pass() { echo "ok   $*"; }
fail() { echo "FAIL $*"; FAIL=1; }
need() { command -v "$1" >/dev/null || { echo "$1 is required"; exit 1; }; }
need curl; need jq

urlenc() { python3 -c 'import sys,urllib.parse; print(urllib.parse.quote(sys.argv[1]))' "$1" 2>/dev/null || jq -rn --arg s "$1" '$s|@uri'; }

# --- health
H=$(curl -fsS -m 10 "$BASE/health") || { fail "/health unreachable"; echo "smoke: $FAIL failure(s)"; exit 1; }
[ "$(jq -r .status <<<"$H")" = "ok" ] && pass "health status ok" || fail "health status $(jq -r .status <<<"$H")"
[ "$(jq -r .version <<<"$H")" = "$EXPECTED" ] && pass "version $EXPECTED" || fail "version $(jq -r .version <<<"$H") != $EXPECTED"
WC=$(jq -r '.warm_cache // "disabled"' <<<"$H")
{ [ "$WC" = "complete" ] || [ "$WC" = "disabled" ]; } && pass "warm_cache $WC" || fail "warm_cache $WC"

# --- simple search
Q=$(urlenc "قال")
R=$(curl -fsS -m 30 "$BASE/search?q=$Q&mode=lemma&limit=5") || { fail "/search request failed"; R='{}'; }
TH=$(jq -r '.total_hits // 0' <<<"$R"); EL=$(jq -r '.elapsed_ms // 99999' <<<"$R")
[ "$TH" -gt 0 ] && pass "/search قال total_hits=$TH" || fail "/search قال total_hits=$TH"
[ "$EL" -lt 500 ] && pass "/search elapsed ${EL}ms < 500" || fail "/search elapsed ${EL}ms >= 500"

# --- proximity (a walk)
# body via stdin: argv is not UTF-8-safe on every platform (Windows consoles)
R=$(curl -fsS -m 60 -H 'Content-Type: application/json' -X POST "$BASE/search/proximity" --data-binary @- <<'JSON'
{"term1":{"query":"الله","mode":"surface"},"term2":{"query":"قال","mode":"lemma"},"distance":10,"limit":5,"offset":0}
JSON
) || { fail "/search/proximity request failed"; R='{}'; }
TH=$(jq -r '.total_hits // 0' <<<"$R"); EL=$(jq -r '.elapsed_ms // 99999' <<<"$R"); N=$(jq -r '.results | length' <<<"$R")
[ "$TH" -gt 0 ] && [ "$N" -gt 0 ] && pass "/search/proximity total_hits=$TH rows=$N" || fail "/search/proximity total_hits=$TH rows=$N"
[ "$EL" -lt 2000 ] && pass "/search/proximity elapsed ${EL}ms < 2000" || fail "/search/proximity elapsed ${EL}ms >= 2000"
KEY=$(jq -r '.walk_key // empty' <<<"$R")
if [ -n "$KEY" ]; then
  code=$(curl -s -o /dev/null -w '%{http_code}' -m 10 "$BASE/search/status?key=$(urlenc "$KEY")")
  [ "$code" = "200" ] && pass "/search/status for the proximity walk" || fail "/search/status HTTP $code"
else
  fail "/search/proximity response carries no walk_key"
fi

# --- wildcard (glob grammar, wide slot)
Q=$(urlenc "ابن ال*")
R=$(curl -fsS -m 60 "$BASE/search/wildcard?q=$Q&limit=5") || { fail "/search/wildcard request failed"; R='{}'; }
TH=$(jq -r '.total_hits // 0' <<<"$R"); EL=$(jq -r '.elapsed_ms // 99999' <<<"$R")
[ "$TH" -gt 0 ] && pass "/search/wildcard ابن ال* total_hits=$TH" || fail "/search/wildcard total_hits=$TH"
[ "$EL" -lt 3000 ] && pass "/search/wildcard elapsed ${EL}ms < 3000" || fail "/search/wildcard elapsed ${EL}ms >= 3000"

# --- 0.4.x compatibility shim: page addressed without part_index
ROW=$(curl -fsS -m 30 "$BASE/search?q=$(urlenc "كتاب")&mode=lemma&limit=1" | jq -r '.results[0] // empty')
if [ -n "$ROW" ]; then
  ID=$(jq -r .id <<<"$ROW"); PID=$(jq -r .page_id <<<"$ROW")
  code=$(curl -s -o /dev/null -w '%{http_code}' -m 30 "$BASE/page/tokens?id=$ID&page_id=$PID")
  [ "$code" = "200" ] && pass "/page/tokens without part_index -> 200 (shim)" || fail "/page/tokens without part_index -> HTTP $code"
else
  fail "no row to test the part_index shim with"
fi

# --- rate limit: 60 concurrent /search requests must produce a 429 with a JSON body
if [ "$EXPECT_429" = "1" ]; then
  # /health is exempt from the limiter, so burst on /genres (cheap, small body);
  # every response is saved so a 429 body can be inspected.
  # One curl process fires 60 requests at once (URL glob [1-60], --parallel);
  # spawning 60 processes would spread the burst out on slow shells.
  BURST=$(mktemp -d)
  curl -s -m 30 --parallel --parallel-immediate --parallel-max 60 \
    -o "$BURST/#1.body" -w '%{http_code} %{filename_effective}\n' "$BASE/genres?burst=[1-60]" > "$BURST/codes" 2>/dev/null || true
  n429=$(grep -c '^429 ' "$BURST/codes" || true)
  if [ "$n429" -gt 0 ]; then
    f=$(grep -m1 '^429 ' "$BURST/codes" | cut -d' ' -f2-); body=$(cut -c1-120 "$f")
    grep -q '"error"' <<<"$body" && pass "rate limit: $n429 x 429, JSON body $body" || fail "rate limit: 429 without a JSON error body: $body"
  else
    fail "rate limit: no 429 in a burst of 60"
  fi
else
  echo "skip rate-limit check (KASHSHAF_SMOKE_RATE_LIMIT=0)"
fi

if [ "$FAIL" -ne 0 ]; then echo "smoke: FAILED"; exit 1; fi
echo "smoke: all checks passed"
