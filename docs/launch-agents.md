# LaunchAgent setup (alert watcher + signal web app)

The alert pipeline runs as two user LaunchAgents on macOS. Plists live in
`~/Library/LaunchAgents/` (user-local, not committed); both run from your
clone of this repo, so a `git pull` updates the running code. Replace
`REPO` below with your absolute clone path and check `which node` for the
node path (launchd does not read your shell PATH).

## 1. `com.market-signals.supertrend` — the watcher

Runs `scripts/supertrend.mjs` once per M5 candle, **aligned to candle
closes**: `StartCalendarInterval` at minutes 1, 6, …, 56 means a flip
confirmed at :05 alerts by ~:06. (A plain `StartInterval 300` drifts against
candle boundaries and adds up to 5 minutes of alert latency — use the
calendar schedule.)

Every tick does more than the watched combo's own alert path:

- **per-combo bots** deliberate on a fresh flip or an adverse-move event for
  their combo (paper trades against `data/candles.db`'s virtual portfolio);
- **higher-timeframe cache refresh** (#81): after the watched combos are
  processed, the watcher tops up M15/M30/H1/H4 candles for every instrument
  that's either watched or has a configured bot, staleness-gated (only fetches
  a rung once it's actually stale) and capped per tick (bounded fan-out after
  a long downtime) — cache-only, no signal evaluation or notifications;
- **sentinel news cache refresh** (#86): same after-the-signal-path,
  best-effort placement as the HTF cache, staleness-gated per instrument
  (~8 min) and capped per tick — polls the market-sentinel skill into the
  `news` table so the filter/bot prompts always read a warm cache instead of
  fetching live news on the alert path.

Both background refreshes are failure-isolated (a fetch error is logged and
skipped, never surfaced as a watcher failure) and never delay or block the
watched combo's own alert. Set `MS_DEBUG_LLM=1` in the LaunchAgent's
environment (or your shell, for a manual run) to log a one-line
provider/model/token-usage summary per LLM completion (filter and bot) to
stderr — a local dev flag, not a persisted setting, and a no-op cost when
unset.

`~/Library/LaunchAgents/com.market-signals.supertrend.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.market-signals.supertrend</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/node</string>
    <string>scripts/supertrend.mjs</string>
    <string>--instrument</string><string>WTICO/USD</string>
    <string>--granularity</string><string>M5</string>
    <string>--count</string><string>500</string>
    <string>--freshBars</string><string>1</string>
    <string>--notify</string><string>true</string>
    <string>--pretty</string><string>false</string>
  </array>
  <key>WorkingDirectory</key><string>REPO</string>
  <!-- Minutes must match the watcher granularity: M5 -> 1,6,...,56.
       For M15 use 1,16,31,46; for M1 use StartInterval 60 instead. -->
  <key>StartCalendarInterval</key>
  <array>
    <dict><key>Minute</key><integer>1</integer></dict>
    <dict><key>Minute</key><integer>6</integer></dict>
    <dict><key>Minute</key><integer>11</integer></dict>
    <dict><key>Minute</key><integer>16</integer></dict>
    <dict><key>Minute</key><integer>21</integer></dict>
    <dict><key>Minute</key><integer>26</integer></dict>
    <dict><key>Minute</key><integer>31</integer></dict>
    <dict><key>Minute</key><integer>36</integer></dict>
    <dict><key>Minute</key><integer>41</integer></dict>
    <dict><key>Minute</key><integer>46</integer></dict>
    <dict><key>Minute</key><integer>51</integer></dict>
    <dict><key>Minute</key><integer>56</integer></dict>
  </array>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>REPO/data/supertrend-launchd.log</string>
  <key>StandardErrorPath</key><string>REPO/data/supertrend-launchd.log</string>
</dict>
</plist>
```

CLI flags pin the watcher; fields set on the config page
(`data/settings.json`) win over script defaults but lose to explicit flags.
To manage the watcher entirely from the web UI, drop the `--instrument` /
`--granularity` / `--freshBars` flags here — and keep the minute list in
sync with whatever granularity you configure.

## 2. `com.market-signals.signal-server` — the web app

Always-on localhost server (`KeepAlive`) so notification deep links resolve
the moment an alert arrives.

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

Port defaults to 8787 (`settings.port` overrides; if you change it, the
watcher builds deep links from the same settings file, so they stay in sync).

Same `MS_DEBUG_LLM=1` flag as the watcher: set it in this LaunchAgent's
environment to surface the completion's provider/model/usage. `/api/recheck`
(non-streamed) gets all four `X-LLM-Provider`/`X-LLM-Model`/`X-LLM-Usage-Input`/
`X-LLM-Usage-Output` headers; the chat SSE stream gets the `X-LLM-Provider`/
`X-LLM-Model` headers plus a trailing `{type:'usage'}` SSE event (headers flush
before the completion, so usage can't ride a header there). With the flag off,
no headers/event are added; `/api/recheck` is byte-identical and the chat SSE
body carries no usage event.

## Ownership (#193)

Exactly one process should run the decision cycle at a time: the
LaunchAgent above (`watcherOwner` unset or `launchagent`, the default), or
the signal-server's own heartbeat (`watcherOwner: 'server'` in
`data/settings.json`, set from the config page's Advanced tab). Both sides
read `watcherOwner` **at run time**, not at process start:

- CLI (`scripts/supertrend.mjs` `main()`): if `watcherOwner === 'server'`, a
  LaunchAgent-triggered run is a no-op (logged to stderr, exits 0) — you do
  **not** need to `launchctl bootout` the watcher plist before flipping
  ownership to the server. Do it anyway if you want the LaunchAgent's log
  file to stop growing with no-op lines.
- Server heartbeat (`scripts/keep-fresh.mjs`): runs the exact same decision
  cycle (`runWatcherCycle`) on the same candle-aligned cadence as the
  plist's `StartCalendarInterval` (local minute % 5 === 1, one bar per
  cycle) when `watcherOwner === 'server'`.

**Plist flags must be mirrored into settings when the LaunchAgent isn't the
owner.** The plist above pins `--instrument`, `--granularity`, and
`--freshBars 1` as CLI flags — those never reach the server heartbeat, which
only reads `data/settings.json`. In particular, `freshBars` defaults to `1`
for the server cycle specifically to match the plist's operating value (the
CLI's own bare default is a looser `2`); if you rely on any *other* flag the
plist pins, set the matching field in settings before cutting over, or the
server cycle will silently run with a different value than the LaunchAgent
did.

Switching `watcherOwner` is a cutover, not a preference — hence its
`.fieldhint.danger` treatment in the config page (same styling as the
`port` field, the other setting a UI change can't apply live).

## Install / manage

```bash
# clickable notifications (optional; osascript fallback otherwise)
brew install terminal-notifier

# load (once per plist; repeat after editing a plist)
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.market-signals.supertrend.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.market-signals.signal-server.plist

# verify
launchctl print gui/$(id -u)/com.market-signals.supertrend | grep -E "state|last exit"
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8787/
tail -f REPO/data/supertrend-launchd.log     # per-run JSON + [supertrend] debug lines

# stop / reload
launchctl bootout gui/$(id -u)/com.market-signals.supertrend
launchctl bootout gui/$(id -u)/com.market-signals.signal-server

# cutting over to watcherOwner: 'server' (optional but recommended — stops
# the watcher plist firing no-op runs on its own cron schedule)
launchctl bootout gui/$(id -u)/com.market-signals.supertrend
```

Notes:

- macOS notifications: the first osascript-fallback notification may require
  allowing "Script Editor" under System Settings → Notifications;
  terminal-notifier registers its own entry on first use.
- Everything under `data/` (db, logs, settings with API keys, notes) is
  gitignored and stays local.
- `RunAtLoad` fires one immediate run at login/bootstrap; agents only run
  while you are logged in.
