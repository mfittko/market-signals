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
```

Notes:

- macOS notifications: the first osascript-fallback notification may require
  allowing "Script Editor" under System Settings → Notifications;
  terminal-notifier registers its own entry on first use.
- Everything under `data/` (db, logs, settings with API keys, notes) is
  gitignored and stays local.
- `RunAtLoad` fires one immediate run at login/bootstrap; agents only run
  while you are logged in.
