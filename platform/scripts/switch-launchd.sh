#!/usr/bin/env bash
# Install the live Market Signals setup under launchd: the engine from this checkout, and the console stack
# (control plane, worker, web) as three KeepAlive jobs. Also retires the old five-minute watcher, which duplicates
# the server's own watcher cycle. Every step is idempotent: run `up` again after a pull to rebuild and reload.
#
#   scripts/switch-launchd.sh status     show what launchd runs and from where (read-only)
#   MS_ALLOW_LIVE_SWITCH=1 scripts/switch-launchd.sh up   switch to this worktree (asks first; -y skips the question)
#   scripts/switch-launchd.sh rollback [--with-watcher]   remove the console jobs and consoleUrl, restore the original server plist and the main checkout;
#                                        the old five-minute watcher stays off unless you add --with-watcher
#
# The engine reads and writes data/ (settings, candles, portfolio). The worktree gets a symlink to the
# main checkout's data/, so no state is copied or lost. Original plists are kept in ~/Library/LaunchAgents/.ms-backup.
#
# `up` repoints the live KeepAlive server, which the spike itself must never do. It refuses to run
# unless MS_ALLOW_LIVE_SWITCH=1 is set, so only an explicit operator decision can move the live engine.
set -euo pipefail

WT="$(cd "$(dirname "$0")/../.." && pwd)"                     # worktree root
. "$(dirname "$0")/main-root.sh"
MAIN="$(main_root "$WT")"  # main checkout
LA="$HOME/Library/LaunchAgents"
BK="$LA/.ms-backup"
UID_="$(id -u)"
SRV=com.market-signals.signal-server
WATCH=com.market-signals.supertrend
API=http://127.0.0.1:8787
PLAT="$WT/platform"
PORT="${MS_CONSOLE_PORT:-3737}"          # the console; 3000 stays free for other projects
PLAT_JOBS="api worker web"
SETTINGS="$MAIN/data/settings.json"

die() { echo "error: $*" >&2; exit 1; }
loaded() { launchctl print "gui/$UID_/$1" >/dev/null 2>&1; }
equity() { curl -fsS -m 8 "$API/api/portfolio" | jq -c '.portfolio | {equity, cash, trades: (.trades | length), positions: (.positions | length)}'; }
workdir() { /usr/libexec/PlistBuddy -c 'Print :WorkingDirectory' "$LA/$SRV.plist" 2>/dev/null || echo "?"; }

# bootout returns before the job is gone, and a bootstrap right after can then fail.
# unload waits for the job to disappear; load retries a few times.
unload() {
  loaded "$1" || return 0
  launchctl bootout "gui/$UID_/$1" || true
  local n=0
  while loaded "$1"; do
    n=$((n + 1)); [ "$n" -gt 20 ] && die "$1 did not unload; run: launchctl bootout gui/$UID_/$1"
    sleep 0.5
  done
}
load() {
  local n=0
  until launchctl bootstrap "gui/$UID_" "$LA/$1.plist" 2>/dev/null; do
    n=$((n + 1)); [ "$n" -ge 5 ] && die "$1 did not load; run: $0 rollback"
    sleep 1
  done
}

wait_health() {
  for _ in $(seq 1 30); do curl -fsS -m 3 "$API/api/health" >/dev/null 2>&1 && return 0; sleep 1; done
  return 1
}

# --- console stack: three KeepAlive jobs that run `dev.sh run <name>` ---
plabel() { echo "com.market-signals.platform-$1"; }

write_plist() { # name
  cat >"$LA/$(plabel "$1").plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>$(plabel "$1")</string>
	<key>ProgramArguments</key>
	<array>
		<string>/bin/bash</string>
		<string>$PLAT/scripts/dev.sh</string>
		<string>run</string>
		<string>$1</string>
	</array>
	<key>WorkingDirectory</key>
	<string>$PLAT</string>
	<key>EnvironmentVariables</key>
	<dict>
		<key>PATH</key>
		<string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
		<key>MS_CONSOLE_PORT</key>
		<string>$PORT</string>
	</dict>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<true/>
	<key>ThrottleInterval</key>
	<integer>10</integer>
	<key>StandardOutPath</key>
	<string>$PLAT/.dev/$1.launchd.log</string>
	<key>StandardErrorPath</key>
	<string>$PLAT/.dev/$1.launchd.log</string>
</dict>
</plist>
PLIST
}

console_health() { curl -fsS -m 3 "http://127.0.0.1:$PORT/api/v1/health" >/dev/null 2>&1; }

# Alert links open the new console once settings.json carries consoleUrl. Writing the same value again changes nothing.
edit_settings() { # jq filter args...
  local tmp; tmp="$(mktemp)"
  jq "$@" "$SETTINGS" >"$tmp" && command cp -f "$tmp" "$SETTINGS"
  rm -f "$tmp"
}

install_console() {
  command -v pnpm >/dev/null || die "pnpm is required"
  command -v go >/dev/null || die "go is required"
  mkdir -p "$PLAT/.dev/bin"
  # the dev.sh processes hold the same ports and the same .next build folder
  "$PLAT/scripts/dev.sh" down
  "$PLAT/scripts/dev.sh" db
  (cd "$PLAT" && go build -o .dev/bin/ ./cmd/api ./cmd/worker)
  [ -d "$PLAT/web/node_modules" ] || (cd "$PLAT/web" && pnpm install --silent)
  (cd "$PLAT/web" && pnpm exec next build)
  for j in $PLAT_JOBS; do unload "$(plabel "$j")"; write_plist "$j"; load "$(plabel "$j")"; done
  for _ in $(seq 1 60); do console_health && return 0; sleep 1; done
  die "the console did not answer on port $PORT; see $PLAT/.dev/web.launchd.log"
}

remove_console() {
  for j in $PLAT_JOBS; do unload "$(plabel "$j")"; rm -f "$LA/$(plabel "$j").plist"; done
}

status() {
  for j in $PLAT_JOBS; do loaded "$(plabel "$j")" && echo "loaded:         $(plabel "$j")" || echo "not loaded:     $(plabel "$j")"; done
  console_health && echo "console:        answering on http://127.0.0.1:$PORT" || echo "console:        not answering on port $PORT"
  echo "worktree:       $WT ($(git -C "$WT" branch --show-current))"
  echo "main checkout:  $MAIN"
  echo "server plist:   working directory $(workdir)"
  for j in "$SRV" "$WATCH"; do loaded "$j" && echo "loaded:         $j" || echo "not loaded:     $j"; done
  [ -L "$WT/data" ] && echo "worktree data:  symlink to $(readlink "$WT/data")" || echo "worktree data:  not linked"
  curl -fsS -m 3 "$API/api/health" >/dev/null 2>&1 && echo "engine:         answering on $API" || echo "engine:         not answering"
}

up() {
  [ "${MS_ALLOW_LIVE_SWITCH:-}" = 1 ] || die "up repoints the live server; set MS_ALLOW_LIVE_SWITCH=1 to confirm this is an operator decision"
  command -v jq >/dev/null || die "jq is required"
  [ -f "$LA/$SRV.plist" ] || [ -f "$BK/$SRV.plist" ] || die "no $SRV plist found"
  [ -f "$WT/scripts/signal-server.mjs" ] || die "worktree has no engine scripts"
  status; echo
  echo "This will:"
  echo "  1. back up the two plists to $BK (only when no backup exists)"
  echo "  2. link $WT/data to $MAIN/data"
  echo "  3. point $SRV at $WT and reload it"
  echo "  4. stop and disable $WATCH (the old five-minute watcher)"
  echo "  5. set consoleUrl in $SETTINGS, so alerts open the new console"
  echo "  6. build the console stack and run it as three launchd jobs on port $PORT (replaces the dev.sh processes)"
  if [ "${1:-}" != "-y" ]; then read -r -p "Continue? [y/N] " a; [ "$a" = y ] || die "cancelled"; fi

  before="$(equity || echo unavailable)"
  mkdir -p "$BK"
  for p in "$SRV" "$WATCH"; do [ -f "$BK/$p.plist" ] || { [ -f "$LA/$p.plist" ] && command cp -f "$LA/$p.plist" "$BK/$p.plist"; }; done

  if [ ! -L "$WT/data" ]; then
    [ -e "$WT/data" ] && command mv "$WT/data" "$WT/data.test-artifacts.$(date +%s)"
    ln -s "$MAIN/data" "$WT/data"
  fi

  /usr/libexec/PlistBuddy -c "Set :WorkingDirectory $WT" "$LA/$SRV.plist"
  plutil -lint "$LA/$SRV.plist" >/dev/null || die "plist is invalid; run: $0 rollback"

  if loaded "$WATCH"; then launchctl bootout "gui/$UID_/$WATCH"; fi
  [ -f "$LA/$WATCH.plist" ] && command mv "$LA/$WATCH.plist" "$BK/$WATCH.plist.disabled"

  edit_settings --arg u "http://127.0.0.1:$PORT" '.consoleUrl = $u'

  # a changed plist only takes effect after a full unload and load; kickstart alone would keep the old directory
  unload "$SRV"
  load "$SRV"

  wait_health || die "engine did not answer within 30 seconds; run: $0 rollback"
  install_console
  after="$(equity || echo unavailable)"
  echo; echo "portfolio before: $before"; echo "portfolio after:  $after"
  [ "$before" = "$after" ] && echo "portfolio unchanged: ok" || echo "note: figures differ. A trade or a price move can explain a small change; compare before deciding."
  echo; status
}

# The old five-minute watcher is restored only with --with-watcher: the server already
# watches every pair, and two cycle owners send duplicate alerts.
rollback() {
  [ -f "$BK/$SRV.plist" ] || die "no backup at $BK"
  remove_console
  edit_settings 'del(.consoleUrl)'
  unload "$SRV"
  command cp -f "$BK/$SRV.plist" "$LA/$SRV.plist"
  load "$SRV"
  if [ "${2:-}" = "--with-watcher" ] && [ -f "$BK/$WATCH.plist" ] && ! loaded "$WATCH"; then
    command cp -f "$BK/$WATCH.plist" "$LA/$WATCH.plist"
    load "$WATCH"
  fi
  wait_health || die "engine did not answer within 30 seconds"
  echo "rolled back."; status
}

case "${1:-status}" in
  status) status ;;
  up) up "${2:-}" ;;
  rollback) rollback "$@" ;;
  *) die "usage: $0 status|up [-y]|rollback [--with-watcher]  (up needs MS_ALLOW_LIVE_SWITCH=1)" ;;
esac
