#!/usr/bin/env bash
# Back up everything that would be painful to lose:
#   - the console database (Postgres): agents, strategies, runs, imported history, advisory positions
#   - the engine's SQLite files (candles, signals) and its settings and notes
#
#   scripts/backup.sh [dest-dir]      dump into <dest-dir>/<timestamp>/ (default: <main checkout>/tmp/backups)
#   (a folder is marked and kept only after its dump verifies; a failed run removes its folder)
#   scripts/backup.sh scheduled       dump into the backupDir root named in data/settings.json (the daily launchd job);
#                                     fails without creating anything when settings.json is missing or not valid JSON,
#                                     or backupDir is unset, not absolute, holds a single quote, is inside the checkout,
#                                     missing or not writable
#   scripts/backup.sh restore <dir>   restore the Postgres dump from a backup directory (asks first)
#   scripts/backup.sh restore-sqlite <dir>  restore candles.db, signals.db and settings.json (asks first); checks the
#                                     backup files first, stops the engine job during the copy, refuses while another
#                                     process holds the databases, and, once the engine is stopped, keeps the old files
#                                     in data/.pre-restore-<timestamp>/
#   scripts/backup.sh prune <dest-dir> apply the retention rule below without taking a backup
#
# Backups keep only the newest 14 folders this script wrote. SQLite copies use the online backup API, so they are
# consistent while the engine runs. Files are mode 600 because settings.json holds API keys.
set -euo pipefail

WT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
. "$(dirname "${BASH_SOURCE[0]}")/main-root.sh"
MAIN="$(main_root "$WT")"
PG="${MS_PG_CONTAINER:-platform-postgres-1}"
KEEP=14

die() { echo "error: $*" >&2; exit 1; }
command -v docker >/dev/null || die "docker is required"

restore() {
  local dir="${1:-}"; [ -f "$dir/console.pgdump" ] && [ -f "$dir/$MARKER" ] || die "usage: $0 restore <backup-dir containing console.pgdump>"
  echo "This replaces the contents of the console database with $dir/console.pgdump."
  read -r -p "Type 'restore' to continue: " a; [ "$a" = restore ] || die "cancelled"
  docker exec -i "$PG" pg_restore -U ms -d ms --clean --if-exists --single-transaction --exit-on-error --no-owner < "$dir/console.pgdump"
  echo "restored."
}

# Only folders this script wrote are pruned: the exact timestamp name AND the marker file inside.
# A destination that also holds the user's own folders (2023-03-taxes, 20240101-000000 copies) keeps them.
STAMP='[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]-[0-9][0-9][0-9][0-9][0-9][0-9]'
MARKER=.ms-backup
prune() {
  local root="${1:-}"; [ -d "$root" ] || die "usage: $0 prune <dest-dir>"
  for d in "$root"/$STAMP; do if [ -f "$d/$MARKER" ]; then echo "$d"; fi; done | sort -r | tail -n +"$((KEEP + 1))" |
    while read -r old; do rm -rf -- "$old"; done
}

backup() {
  command -v sqlite3 >/dev/null || die "sqlite3 is required"
  local root="$1" out; out="$root/$(date +%Y%m%d-%H%M%S)"
  # plain mkdir: a second run in the same second fails here instead of sharing (and on failure deleting) this folder,
  # and a root that vanished after the scheduled checks (an unmounted disk) is not created on the main disk
  mkdir "$out" || die "could not create the backup folder (it already exists, or its root is missing): $out"
  chmod 700 "$out"
  # a failed run leaves no folder behind; the path is expanded now because bash 3.2 (/bin/bash) drops locals before EXIT
  trap "rm -rf -- $(printf '%q' "$out")" EXIT
  docker exec "$PG" pg_dump -U ms -d ms --format=custom --no-owner > "$out/console.pgdump"
  for f in candles.db signals.db; do [ -f "$MAIN/data/$f" ] && sqlite3 "$MAIN/data/$f" ".backup '$out/$f'"; done
  for f in settings.json notes.md; do [ -f "$MAIN/data/$f" ] && command cp -p "$MAIN/data/$f" "$out/$f"; done
  chmod 600 "$out"/*
  # prove the dump is readable before trusting it
  docker exec -i "$PG" pg_restore --list < "$out/console.pgdump" >/dev/null || die "the Postgres dump is not readable: $out"
  for f in candles.db signals.db; do
    [ -f "$out/$f" ] || continue
    [ "$(sqlite3 "$out/$f" 'pragma integrity_check')" = ok ] || die "the SQLite copy failed its integrity check: $out/$f"
  done
  : > "$out/$MARKER" # only a verified backup is marked, so prune and restore never see a broken one
  trap - EXIT
  prune "$root"
  echo "backup written to $out ($(du -sh "$out" | cut -f1))"
}

# The scheduled job must never write to the main disk by accident, so it never creates its root.
scheduled() {
  local root main settings="$MAIN/data/settings.json"
  command -v jq >/dev/null || die "jq is required"
  [ -f "$settings" ] || die "scheduled backup: $settings is missing"
  root="$(jq -r '.backupDir // empty' "$settings")" || die "scheduled backup: $settings could not be read as JSON"
  [ -n "$root" ] || die "scheduled backup: backupDir is not set in $settings"
  case "$root" in /*) ;; *) die "scheduled backup: backupDir must be an absolute path: $root" ;; esac
  # backup() passes the path to sqlite3 inside '...', which a single quote would end early
  case "$root" in *"'"*) die "scheduled backup: backupDir must not contain a single quote: $root" ;; esac
  [ -d "$root" ] || die "scheduled backup: backupDir does not exist: $root"
  # /bin/pwd returns the on-disk case; the builtin keeps the typed case, which a case-insensitive disk would let past
  main="$(cd "$MAIN" && /bin/pwd -P)"
  case "$(cd "$root" && /bin/pwd -P)/" in "$main"/*) die "scheduled backup: backupDir is inside the checkout $MAIN: $root" ;; esac
  [ -w "$root" ] || die "scheduled backup: backupDir is not writable: $root"
  echo "$(date '+%Y-%m-%d %H:%M:%S') scheduled backup into $root"
  backup "$root"
}

SRV=com.market-signals.signal-server
start_engine() {
  launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/$SRV.plist" ||
    echo "warning: could not start $SRV; run: launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/$SRV.plist" >&2
}

restore_sqlite() {
  local dir="${1:-}" data="$MAIN/data" pre f n=0 stopped=0
  [ -f "$dir/$MARKER" ] || die "usage: $0 restore-sqlite <backup-dir containing $MARKER>"
  command -v sqlite3 >/dev/null || die "sqlite3 is required"
  command -v lsof >/dev/null || die "lsof is required"
  # a damaged backup file is refused before anything stops or changes
  for f in candles.db signals.db; do
    [ -f "$dir/$f" ] || continue
    [ "$(sqlite3 "$dir/$f" 'pragma integrity_check')" = ok ] || die "the backup file failed its integrity check: $dir/$f; nothing was restored"
  done
  echo "This replaces candles.db, signals.db and settings.json in $data with the copies in $dir."
  read -r -p "Type 'restore' to continue: " a; [ "$a" = restore ] || die "cancelled"
  if launchctl print "gui/$(id -u)/$SRV" >/dev/null 2>&1; then
    launchctl bootout "gui/$(id -u)/$SRV" 2>/dev/null || true
    # armed before the wait: a job that unloads only after the wait gives up still starts again
    stopped=1
    trap start_engine EXIT # the engine job this run stopped starts again on a failure too
    while launchctl print "gui/$(id -u)/$SRV" >/dev/null 2>&1; do
      n=$((n + 1)); [ "$n" -gt 20 ] && die "$SRV was asked to stop but did not stop within 10 s; nothing was restored"
      sleep 0.5
    done
  fi
  # an engine started outside launchd (node scripts/signal-server.mjs) still holds the files
  for f in candles.db signals.db; do
    if [ -f "$data/$f" ] && lsof -t -- "$data/$f" >/dev/null 2>&1; then
      die "a process still holds $data/$f (an engine running outside launchd?); stop it first; nothing was restored"
    fi
  done
  # the rollback copy is taken only now, so no engine write lands between it and the restore
  pre="$data/.pre-restore-$(date +%Y%m%d-%H%M%S)"
  mkdir -p "$pre" && chmod 700 "$pre"
  for f in candles.db signals.db; do [ -f "$data/$f" ] && sqlite3 "$data/$f" ".backup '$pre/$f'"; done
  if [ -f "$data/settings.json" ]; then command cp -p "$data/settings.json" "$pre/settings.json"; fi
  echo "the current files are kept in $pre"
  for f in candles.db signals.db; do
    [ -f "$dir/$f" ] || continue
    command rm -f "$data/$f-wal" "$data/$f-shm"
    command cp -p "$dir/$f" "$data/$f"
    [ "$(sqlite3 "$data/$f" 'pragma integrity_check')" = ok ] || die "the restored file failed its integrity check: $data/$f (old files in $pre)"
  done
  if [ -f "$dir/settings.json" ]; then command cp -p "$dir/settings.json" "$data/settings.json"; fi
  trap - EXIT
  if [ "$stopped" = 1 ]; then start_engine; fi
  echo "restored."
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
case "${1:-}" in
  restore) restore "${2:-}" ;;
  restore-sqlite) restore_sqlite "${2:-}" ;;
  scheduled) scheduled ;;
  prune) prune "${2:-}" ;;
  # only a manual run creates its root; the scheduled job never does
  *) root="${1:-$MAIN/tmp/backups}"; mkdir -p "$root"; backup "$root" ;;
esac
fi
