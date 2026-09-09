#!/usr/bin/env bash
# sample-supply.sh
#
# Re-fetches the same set of public "free stuff near Houston" pages used for the
# 2026-09-09 supply-signal sample, saving raw HTML/text with a UTC timestamp so
# the sample can be repeated daily (e.g. for a week) and compared day over day.
#
# Usage:
#   ./sample-supply.sh                # fetch everything into the default raw dir
#   RAW_DIR=/some/other/dir ./sample-supply.sh
#
# Notes:
#   - This only fetches publicly reachable pages. Trash Nothing's developer and
#     houston-free pages, Craigslist's RSS variant, and OfferUp are expected to
#     return non-200 (Cloudflare/bot-block challenges) from most container/CI
#     IPs — the script records whatever HTTP code it gets rather than treating
#     it as fatal.
#   - It does NOT classify or count listings; run classify-supply.py (or the
#     inline python in supply-signal-houston.md's method section) against the
#     saved HTML to reproduce the classification table for a given day.
#   - Never disable TLS verification and never fabricate a result for a source
#     that 403s or times out — leave that day's cell blank/"blocked" instead.

set -uo pipefail

RAW_DIR="${RAW_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/supply-raw}"
mkdir -p "$RAW_DIR"

TS="$(date -u +%Y%m%dT%H%M%SZ)"
UA="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36"

echo "== sample-supply.sh run $TS =="
echo "Saving to: $RAW_DIR"

# name|url
SOURCES=(
  "trashnothing_openapi|https://trashnothing.com/api/v1.4/trashnothing-openapi.yaml"
  "trashnothing_developer|https://trashnothing.com/developer"
  "trashnothing_developer_app|https://trashnothing.com/app/developer"
  "trashnothing_houston_free|https://trashnothing.com/houston-free"
  "craigslist_zip|https://houston.craigslist.org/search/zip"
  "craigslist_zip_rss|https://houston.craigslist.org/search/zip?format=rss"
  "nextdoor_free|https://nextdoor.com/marketplace/houston--tx/free/"
  "offerup_houston_free|https://offerup.com/search/?q=free&location=Houston%2C%20TX"
)

SUMMARY="$RAW_DIR/${TS}_SUMMARY.txt"
: > "$SUMMARY"

for entry in "${SOURCES[@]}"; do
  name="${entry%%|*}"
  url="${entry#*|}"
  out="$RAW_DIR/${TS}_${name}.html"
  err="$RAW_DIR/${TS}_${name}.err"
  code=$(curl -sS -L --max-time 30 \
    -A "$UA" \
    -o "$out" -w "%{http_code}" \
    "$url" 2>"$err")
  size=$(wc -c < "$out" 2>/dev/null || echo 0)
  line="$name -> HTTP $code (${size} bytes) url=$url"
  echo "$line"
  echo "$line" >> "$SUMMARY"
  # Drop empty .err files to keep the directory tidy.
  [ -s "$err" ] || rm -f "$err"
done

echo
echo "Done. Summary: $SUMMARY"
echo "Re-run this script once a day for a week, then diff/compare the per-day"
echo "*_SUMMARY.txt files and re-run the classification step against each"
echo "day's craigslist_zip and nextdoor_free HTML to see whether the"
echo "sentimental-fraction estimate is stable."
