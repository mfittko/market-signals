#!/usr/bin/env bash
# Back up everything that would be painful to lose:
#   - the console database (Postgres): agents, strategies, runs, imported history, advisory positions
#   - the engine's SQLite files (candles, signals) and its settings and notes
#
#   scripts/backup.sh [dest-dir]      dump into <dest-dir>/<timestamp>/ (default: <main checkout>/tmp/backups)
#   scripts/backup.sh restore <dir>   restore the Postgres dump from a backup directory (asks first)
#
# Backups keep only the newest 14 timestamped folders. SQLite copies use the online backup API, so they are
# consistent while the engine runs. Files are mode 600 because settings.json holds API keys.
set -euo pipefail

WT="$(cd "$(dirname "$0")/../.." && pwd)"
MAIN="$(cd "$(git -C "$WT" rev-parse --git-common-dir)/.." && pwd)"
PG="${MS_PG_CONTAINER:-platform-postgres-1}"
KEEP=14

die() { echo "error: $*" >&2; exit 1; }
command -v docker >/dev/null || die "docker is required"

restore() {
  local dir="${1:-}"; [ -f "$dir/console.pgdump" ] || die "usage: $0 restore <backup-dir containing console.pgdump>"
  echo "This replaces the contents of the console database with $dir/console.pgdump."
  read -r -p "Type 'restore' to continue: " a; [ "$a" = restore ] || die "cancelled"
  docker exec -i "$PG" pg_restore -U ms -d ms --clean --if-exists --no-owner < "$dir/console.pgdump"
  echo "restored."
}

backup() {
  command -v sqlite3 >/dev/null || die "sqlite3 is required"
  local root="${1:-$MAIN/tmp/backups}" out; out="$root/$(date +%Y%m%d-%H%M%S)"
  mkdir -p "$out" && chmod 700 "$out"
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
  # retention: newest $KEEP folders that look like timestamps
  ls -1d "$root"/[0-9]*-[0-9]* 2>/dev/null | sort -r | tail -n +"$((KEEP + 1))" | while read -r old; do rm -rf -- "$old"; done
  echo "backup written to $out ($(du -sh "$out" | cut -f1))"
}

case "${1:-}" in
  restore) restore "${2:-}" ;;
  *) backup "${1:-}" ;;
esac
