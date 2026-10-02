---
title: Guide · Market Signals
description: How to run Market Signals on your own machine, and what a trading day looks like in the console.
---

# Using Market Signals

<p class="lede">You run Market Signals on your own machine. It needs macOS or Linux, a current Node release and a language model key. Market data needs no key. The agent console also needs Docker and Go.</p>

## Start the engine and the console

The engine serves its own dashboard and runs the decision cycle on every candle.

```sh
git clone https://github.com/mfittko/market-signals
cd market-signals
node scripts/signal-server.mjs        # engine on http://127.0.0.1:8787
```

The agent console runs next to it.

```sh
cd platform
scripts/dev.sh up                     # Postgres, control plane, worker, console
open http://127.0.0.1:3000
```

In the console's Settings, enter your model endpoint and key, then tick the markets and timeframes you want to watch.

## Check the desk

The desk lists every watched market. A green badge shows that a bot is on, and each card shows the last signal and the age of its data.

![The desk with three watched markets.](screen:desk "You can filter the desk by market type, or show only markets with an active bot.")

## Open a market

The instrument page shows the live chart with the supertrend line, each flip, volume and news markers. The table below it lists every signal with the filter's verdict and reason. The right column holds the agents, the copilot chat and the latest headlines.

The news card shows headlines in English and only those that can move this market. The model translates each headline, judges its relevance and summarizes the article, and the console keeps those results. The card opens on escalations, and you can switch to all relevant headlines. Hover a headline to read its summary.

![The WTI M5 instrument page.](screen:instrument "Live candles, signals with their verdicts, agents and news on one page.")

## Ask an agent

Press "Check now" on an agent. The console freezes the current state and asks the agent whether its strategy's entry conditions hold, and the answer arrives within seconds. The run page shows every tool call, every model round and the result of the deterministic checks.

![A finished run.](screen:run "The run page shows whether the agent chose hold or open, and why.")

## Refine a strategy

A strategy is a versioned prompt. You can edit it, compare it with an earlier version or refine it with the grill. The guided grill asks one question at a time and marks a recommended answer. The automatic grill replays past signals and reports which settings held up on data it did not tune on.

![The strategy editor.](screen:strategies "Each save creates a new version, and nothing changes until you press save.")

## Follow the alerts

The alerts page puts signals, agent proposals and paper trades on one time line. A desktop notification opens the matching instrument page.

![The alerts page.](screen:alerts "Signals, proposals and trades in time order.")

## Keep it local

Market Signals trades paper money only, and agents can only propose. Keep the console on your own machine, because remote access has no authentication yet.
