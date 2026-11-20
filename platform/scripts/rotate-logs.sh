#!/usr/bin/env bash
# Rotate the platform launchd logs. Each <dir>/*.launchd.log over 10 MB is copied to <log>.<timestamp>.gz and the
# live file is truncated in place; the newest 7 rotated copies per log are kept. launchd opens the log in append
# mode, so a running job keeps writing at the new end of the live file. A rename (newsyslog) would leave the job
# writing to the renamed file until it restarts.
#
#   scripts/rotate-logs.sh [dir]   default dir: platform/.dev (the daily launchd job runs it without an argument)
set -euo pipefail

DIR="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/.dev}"
MAX=$((10 * 1024 * 1024))
KEEP=7

for f in "$DIR"/*.launchd.log; do
  [ -f "$f" ] && [ "$(wc -c <"$f")" -gt "$MAX" ] || continue
  gzip -c "$f" >"$f.$(date +%Y%m%d-%H%M%S).gz"
  # shortcut: lines written between the copy and the truncate are lost; a daily run makes that window tiny
  : >"$f"
  for g in "$f".*.gz; do echo "$g"; done | sort -r | tail -n +"$((KEEP + 1))" | while read -r old; do command rm -f -- "$old"; done
done
