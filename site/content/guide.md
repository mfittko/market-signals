---
title: Guide · Market Signals
description: How to run Market Signals on your own machine and how a trading day looks in the console.
---

# Guide

<p class="lede">Market Signals runs on your own machine. You need macOS or Linux, a current Node release, and an API key for a market data provider and a language model. The agent console also needs Docker and Go.</p>

> The agent console ships with v0.2.0. Until then it lives on the [prototype branch](https://github.com/mfittko/market-signals/pull/232).

## Run it

Start the engine. It serves its own dashboard and runs the decision cycle on every candle.

```sh
git clone https://github.com/mfittko/market-signals
cd market-signals
node scripts/signal-server.mjs        # engine on http://127.0.0.1:8787
```

Start the agent console next to it.

```sh
cd platform
scripts/dev.sh up                     # Postgres, control plane, worker, console
open http://127.0.0.1:3000
```

Open Settings in the console, enter your model endpoint and key, and pick the markets and timeframes to watch.

## A day at the desk

### 1. Scan the desk

The desk lists every watched market. A green badge means a bot is on. Each row shows the last signal and how fresh the data is.

![The desk with three watched markets.](screen:desk "The desk. Filter by market type or show only markets with an active bot.")

### 2. Open a market

The instrument page shows the live chart with the supertrend line, every flip, volume and the news markers. Below it are the signals with the filter's verdict and reason. On the right you can ask the copilot, check the agents and read the news.

![The WTI M5 instrument page.](screen:instrument "An instrument. Live candles, signals with their verdict, agents and news in one place.")

### 3. Ask an agent

Press "Check now" on an agent. It freezes the current state and asks whether the strategy's entry conditions hold. The answer comes back in a few seconds with its reasons. Open the run to see every tool call, every model round and the deterministic checks.

![A finished run.](screen:run "A run. Hold or open, and exactly why.")

### 4. Shape your strategy

Strategies are versioned prompts. Edit one, compare it with an earlier version, or sharpen it with the grill. The guided grill asks one question at a time with a recommended answer. The automatic grill replays past signals and reports what held up on data it did not tune on.

![The strategy editor.](screen:strategies "Strategies. Every save is a new version, and nothing changes until you save.")

### 5. Follow the alerts

The alerts page collects signals, agent proposals and paper trades in one time line. Desktop notifications open the matching instrument page.

![The alerts page.](screen:alerts "Alerts. One time line for signals, proposals and trades.")

## Safety

Market Signals uses paper money only. Agents propose and do not trade. The position monitor handles every exit with plain rules. Keep the console on your own machine. Remote access without authentication is not supported.
