#!/usr/bin/env bash
# Run the console stack under launchd, so it starts at login and restarts when it dies.
#
#   scripts/launchd-platform.sh install     build, stop the dev.sh processes, write and load the three jobs
#   scripts/launchd-platform.sh uninstall   unload and remove the three jobs (Postgres keeps running)
#   scripts/launchd-platform.sh status      show which jobs are loaded and whether the console answers
#
# Jobs: com.market-signals.platform-api, -worker and -web. Each runs `dev.sh run <name>` from this checkout.
# The console listens on MS_CONSOLE_PORT (default 3737), the control plane on 8080, Postgres on 5544.
# Postgres is the docker container from docker-compose.yml. It has restart: unless-stopped, so it comes back
# whenever Docker Desktop starts; start Docker Desktop at login for a fully unattended stack.
# Logs: .dev/<name>.launchd.log. Do not run dev.sh up and these jobs together: they use the same ports.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
LA="$HOME/Library/LaunchAgents"
UID_="$(id -u)"
PORT="${MS_CONSOLE_PORT:-3737}"
JOBS="api worker web"

die() { echo "error: $*" >&2; exit 1; }
label() { echo "com.market-signals.platform-$1"; }
loaded() { launchctl print "gui/$UID_/$(label "$1")" >/dev/null 2>&1; }

unload() {
  loaded "$1" || return 0
  launchctl bootout "gui/$UID_/$(label "$1")" || true
  local n=0
  while loaded "$1"; do
    n=$((n + 1)); [ "$n" -gt 20 ] && die "$(label "$1") did not unload"
    sleep 0.5
  done
}

load() {
  local n=0
  until launchctl bootstrap "gui/$UID_" "$LA/$(label "$1").plist" 2>/dev/null; do
    n=$((n + 1)); [ "$n" -gt 5 ] && die "could not load $(label "$1")"
    sleep 1
  done
}

write_plist() { # name
  cat >"$LA/$(label "$1").plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>$(label "$1")</string>
	<key>ProgramArguments</key>
	<array>
		<string>/bin/bash</string>
		<string>$ROOT/scripts/dev.sh</string>
		<string>run</string>
		<string>$1</string>
	</array>
	<key>WorkingDirectory</key>
	<string>$ROOT</string>
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
	<string>$ROOT/.dev/$1.launchd.log</string>
	<key>StandardErrorPath</key>
	<string>$ROOT/.dev/$1.launchd.log</string>
</dict>
</plist>
EOF
}

status() {
  for j in $JOBS; do
    if loaded "$j"; then echo "loaded:     $(label "$j")"; else echo "not loaded: $(label "$j")"; fi
  done
  local code; code="$(curl -s -o /dev/null -m 5 -w '%{http_code}' "http://127.0.0.1:$PORT/api/v1/health" || true)"
  echo "console:    http://127.0.0.1:$PORT answers $code"
}

install() {
  command -v pnpm >/dev/null || die "pnpm is required"
  command -v go >/dev/null || die "go is required"
  mkdir -p "$ROOT/.dev/bin" "$LA"
  # stop the dev.sh processes first: they hold the same ports and the same .next build folder
  scripts/dev.sh down
  scripts/dev.sh db
  go build -o "$ROOT/.dev/bin/" ./cmd/api ./cmd/worker
  [ -d web/node_modules ] || (cd web && pnpm install --silent)
  (cd web && pnpm exec next build)
  for j in $JOBS; do unload "$j"; write_plist "$j"; load "$j"; done
  echo "waiting for the console"
  for _ in $(seq 1 60); do
    curl -fsS -m 2 "http://127.0.0.1:$PORT/api/v1/health" >/dev/null 2>&1 && break
    sleep 1
  done
  status
}

uninstall() {
  for j in $JOBS; do unload "$j"; rm -f "$LA/$(label "$j").plist"; done
  echo "removed; run scripts/dev.sh up for the development stack"
}

case "${1:-status}" in
  install) install ;;
  uninstall) uninstall ;;
  status) status ;;
  *) die "usage: $0 install|uninstall|status" ;;
esac
