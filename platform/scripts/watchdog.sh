#!/usr/bin/env bash
# Watch the live stack from outside it. `switch-launchd.sh up` installs a launchd job that runs this every 5 minutes.
# It uses only bash, curl, jq, find and osascript, so it still runs while the API, Postgres or Docker are down.
#
#   backup: fails when no marked backup folder under backupDir (data/settings.json) is newer than 26 hours,
#           or backupDir is unset or missing; it notifies at once
#   health: fails when http://127.0.0.1:8080/api/v1/health does not answer 2xx; it notifies once the failure
#           has lasted 10 minutes in a row (a passing run resets the clock, and so does a gap of more than
#           15 minutes since the last run, such as a Mac sleep or a stopped job, because no run saw that time)
#
# Each failure notifies once, and the first passing run after that notification notifies the recovery once.
# The notification is a desktop notification, plus a Pushover push when PUSHOVER_ENABLED, PUSHOVER_TOKEN and
# PUSHOVER_USER are set in data/settings.json. State lives in platform/.dev/watchdog/, one file per check.
set -euo pipefail

WT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
. "$(dirname "${BASH_SOURCE[0]}")/main-root.sh"
MAIN="$(main_root "$WT")"
SETTINGS="$MAIN/data/settings.json"
STATE="$WT/platform/.dev/watchdog"
HEALTH_URL=http://127.0.0.1:8080/api/v1/health
BACKUP_MAX_MIN=$((26 * 60)) # the daily job runs at 03:30, so 26 hours allows one late run
HEALTH_GRACE_S=600
STAMP='[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]-[0-9][0-9][0-9][0-9][0-9][0-9]' # the folder name backup.sh writes
MARKER=.ms-backup

now() { date +%s; }

notify() { # message
  echo "$(date '+%F %T') $1"
  # the message goes in as an argument, so no text can break the AppleScript
  osascript -e 'on run argv' -e 'display notification (item 1 of argv) with title "market-signals watchdog"' -e 'end run' "$1" >/dev/null 2>&1 || true
  jq -e '(.PUSHOVER_ENABLED | . == "1" or . == true or . == 1) and (.PUSHOVER_TOKEN // "") != "" and (.PUSHOVER_USER // "") != ""' \
    "$SETTINGS" >/dev/null 2>&1 || return 0
  # the token and user key go to curl on stdin, never on argv, which any ps snapshot shows
  jq -r --arg m "$1" '{token: .PUSHOVER_TOKEN, user: .PUSHOVER_USER, title: "market-signals", message: $m}
      | to_entries | map("\(.key)=\(.value | @uri)") | join("&")' "$SETTINGS" |
    curl -fsS -m 5 -d @- https://api.pushover.net/1/messages.json >/dev/null || echo "warning: the Pushover push failed" >&2
}

backup_ok() {
  local root m
  root="$(jq -r '.backupDir // empty' "$SETTINGS" 2>/dev/null || true)"
  [ -n "$root" ] && [ -d "$root" ] || return 1
  for m in "$root"/$STAMP/$MARKER; do
    if [ -f "$m" ] && [ -n "$(find "$m" -mmin -"$BACKUP_MAX_MIN")" ]; then return 0; fi
  done
  return 1
}

health_ok() { curl -fsS -m 5 "$HEALTH_URL" >/dev/null 2>&1; }

# The state file holds "<failing since, epoch seconds> <alert sent, 0 or 1>"; a passing run removes it.
# A missing, empty or malformed state file counts as a failure that starts now. Every failing run rewrites the
# file, so a file older than 15 minutes means runs were missed: the failure restarts now and keeps its alert flag.
track() { # name failed(0|1) grace-seconds failure-message recovery-message
  local f="$STATE/$1" since="" alerted=""
  if [ -f "$f" ]; then read -r since alerted <"$f" || true; fi
  # a leading zero would make bash arithmetic read the value as octal and abort the run
  [[ "$since" =~ ^[1-9][0-9]*$ && "$alerted" =~ ^[01]$ ]] || { since="$(now)"; alerted=0; }
  if [ -f "$f" ] && [ -n "$(find "$f" -mmin +15)" ]; then since="$(now)"; fi
  if [ "$2" = 0 ]; then
    if [ "$alerted" = 1 ]; then notify "$5"; fi
    command rm -f "$f"
    return 0
  fi
  if [ "$alerted" = 0 ] && [ $(($(now) - since)) -ge "$3" ]; then notify "$4"; alerted=1; fi
  echo "$since $alerted" >"$f.tmp"
  command mv -f "$f.tmp" "$f"
}

run() {
  local b=0 h=0
  mkdir -p "$STATE"
  backup_ok || b=1
  health_ok || h=1
  track backup "$b" 0 "No backup newer than 26 hours in backupDir, or backupDir is unset or missing." "Backups are current again."
  track health "$h" "$HEALTH_GRACE_S" "The platform API health check has failed for 10 minutes." "The platform API health check passes again."
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then run; fi
