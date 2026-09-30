#!/usr/bin/env bash
# Back up everything that would be painful to lose:
#   - the console database (Postgres): agents, strategies, runs, imported history, advisory positions
#   - the engine's SQLite files (candles, signals) and its settings and notes
#
#   scripts/backup.sh [dest-dir]      dump into <dest-dir>/<timestamp>/ (default: <main checkout>/tmp/backups)
#   (a folder is marked and kept only after its dump verifies; a failed run removes its folder)
#   scripts/backup.sh restore <dir>   restore the Postgres dump from a backup directory (asks first)
#   scripts/backup.sh prune <dest-dir> apply the retention rule below without taking a backup
#
# Backups keep only the newest 14 folders this script wrote. SQLite copies use the online backup API, so they are
# consistent while the engine runs. Files are mode 600 because settings.json holds API keys.
set -euo pipefail

WT="$(cd "$(dirname "$0")/../.." && pwd)"
. "$(dirname "$0")/main-root.sh"
MAIN="$(main_root "$WT")"
PG="${MS_PG_CONTAINER:-platform-postgres-1}"
KEEP=14

die() { echo "error: $*" >&2; exit 1; }
command -v docker >/dev/null || die "docker is required"

restore() {
  local dir="${1:-}"; [ -f "$dir/console.pgdump" ] && [ -f "$dir/$MARKER" ] || die "usage: $0 restore <backup-dir containing console.pgdump>"
  echo "This replaces the contents of the console database with $dir/console.pgdump."
  read -r -p "Type 'restore' to continue: " a; [ "$a" = restore ] || die "cancelled"
  docker exec -i "$PG" pg_restore -U ms -d ms --clean --if-exists --no-owner < "$dir/console.pgdump"
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
  local root="${1:-$MAIN/tmp/backups}" out; out="$root/$(date +%Y%m%d-%H%M%S)"
  mkdir -p "$out" && chmod 700 "$out"
  trap 'rm -rf -- "$out"' EXIT # a failed run leaves no folder behind
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

case "${1:-}" in
  restore) restore "${2:-}" ;;
  prune) prune "${2:-}" ;;
  *) backup "${1:-}" ;;
esac
