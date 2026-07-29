# LaunchAgent setup (signal web app)

The signal-server runs as a single user LaunchAgent on macOS
(`com.market-signals.signal-server`) — the server's own heartbeat
(`scripts/keep-fresh.mjs`) owns candle fetching, the decision cycle, and
alerts; the LaunchAgent's only job is `KeepAlive` so the process (and
notification deep links) survive a crash/reboot. Plists live in
`~/Library/LaunchAgents/` (user-local, not committed) and run from your
clone of this repo, so a `git pull` updates the running code. Replace
`REPO` below with your absolute clone path and check `which node` for the
node path (launchd does not read your shell PATH).

## `com.market-signals.signal-server` — the web app + decision cycle

Always-on localhost server (`KeepAlive`) so notification deep links resolve
the moment an alert arrives. Its heartbeat (`scripts/keep-fresh.mjs`) runs
the decision cycle (`runWatcherCycle`) on each watched combo's own
candle-aligned cadence (`cycleMinutes[gran]`, default: the bar length capped at 5, so M1 cycles every bar — see #195), plus:

- **per-combo bots** deliberate on a fresh flip or an adverse-move event for
  their combo (paper trades against `data/candles.db`'s virtual portfolio);
- **higher-timeframe cache refresh** (#81): after the watched combos are
  processed, tops up M15/M30/H1/H4 candles for every instrument that's
  either watched or has a configured bot, staleness-gated (only fetches a
  rung once it's actually stale) and capped per tick (bounded fan-out after
  a long downtime) — cache-only, no signal evaluation or notifications;
- **sentinel news cache refresh** (#86): same after-the-signal-path,
  best-effort placement as the HTF cache, staleness-gated per instrument
  (~8 min) and capped per tick — polls the market-sentinel skill into the
  `news` table so the filter/bot prompts always read a warm cache instead of
  fetching live news on the alert path.

Both background refreshes are failure-isolated (a fetch error is logged and
skipped, never surfaced as a cycle failure) and never delay or block the
watched combo's own alert.

`~/Library/LaunchAgents/com.market-signals.signal-server.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.market-signals.signal-server</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/node</string>
    <string>scripts/signal-server.mjs</string>
  </array>
  <key>WorkingDirectory</key><string>REPO</string>
  <key>KeepAlive</key><true/>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>REPO/data/signal-server-launchd.log</string>
  <key>StandardErrorPath</key><string>REPO/data/signal-server-launchd.log</string>
</dict>
</plist>
```

Port defaults to 8787 (`settings.port` overrides). Watched combos,
cadence, and every other field the cycle needs come from the config page
(`data/settings.json`'s `watchers`/`instrument`/`granularity`/`freshBars`/
`cycleMinutes`, etc.) — no CLI flags to keep in sync.

Set `MS_DEBUG_LLM=1` in this LaunchAgent's environment (or your shell, for a
manual run) to log a one-line provider/model/token-usage summary per LLM
completion (filter and bot) to stderr — a local dev flag, not a persisted
setting, and a no-op cost when unset. `/api/recheck`
(non-streamed) gets all four `X-LLM-Provider`/`X-LLM-Model`/`X-LLM-Usage-Input`/
`X-LLM-Usage-Output` headers; the chat SSE stream gets the `X-LLM-Provider`/
`X-LLM-Model` headers plus a trailing `{type:'usage'}` SSE event (headers flush
before the completion, so usage can't ride a header there). With the flag off,
no headers/event are added; `/api/recheck` is byte-identical and the chat SSE
body carries no usage event.

## `scripts/supertrend.mjs` CLI — manual/debug runner only (#199)

The server heartbeat above is the only decision-cycle owner. `scripts/
supertrend.mjs` still exists as a manual/debug CLI (`node scripts/
supertrend.mjs --instrument ... --granularity ...`, `--help` for the full
flag list) for one-off checks or backtests. Running it while the
signal-server is up is **not guarded against**: it will execute its own
decision cycle independently of the heartbeat, which can double-notify or
double-write a decision for the same bar. That's on you — don't run it
against a combo the live server is already watching unless you mean to.

## Install / manage

```bash
# clickable notifications (optional; osascript fallback otherwise)
brew install terminal-notifier

# load (once; repeat after editing the plist)
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.market-signals.signal-server.plist

# verify
launchctl print gui/$(id -u)/com.market-signals.signal-server | grep -E "state|last exit"
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8787/
curl -s http://127.0.0.1:8787/api/health | head -c 400   # cycle: {lastCycleAt, lastCycleError}
tail -f REPO/data/signal-server-launchd.log

# stop / reload
launchctl bootout gui/$(id -u)/com.market-signals.signal-server
```

### Decommissioning an existing supertrend watcher install (#199)

If you previously ran the two-process (#193) setup, the standalone watcher
LaunchAgent is no longer needed — the server heartbeat has taken over its
job. Unload and remove it:

```bash
launchctl bootout gui/$(id -u)/com.market-signals.supertrend
rm ~/Library/LaunchAgents/com.market-signals.supertrend.plist
```

A stored `watcherOwner` key in `data/settings.json` is harmless and ignored
(no read/write in the code reads it anymore); it's fine to leave it or
delete it manually.

Notes:

- macOS notifications: the first osascript-fallback notification may require
  allowing "Script Editor" under System Settings → Notifications;
  terminal-notifier registers its own entry on first use.
- Everything under `data/` (db, logs, settings with API keys, notes) is
  gitignored and stays local.
- `RunAtLoad` fires one immediate run at login/bootstrap; the agent only
  runs while you are logged in.
