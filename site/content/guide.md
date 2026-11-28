---
title: Guide · Market Signals
description: How to run Market Signals on your own machine, and what a trading day looks like in the console.
---

# Using Market Signals

<p class="lede">You run Market Signals on your own machine. It needs macOS or Linux, Node 22.18 or later, and a language model key or a Claude Code login. Market data needs no key. The agent console also needs Docker, Go, pnpm, jq and openssl.</p>

## Start the engine and the console

The engine serves its own dashboard on http://127.0.0.1:8787 and runs the decision cycle on every candle. The engine is end of life. You still need it until the Go control plane takes over all of its jobs in v0.13.0.

```sh
git clone https://github.com/mfittko/market-signals
cd market-signals
node scripts/signal-server.mjs
```

The agent console runs next to it. The `db` step runs once, before the first `up`, and only in the main checkout. It creates the Postgres container.

```sh
cd platform
scripts/dev.sh db
# control plane, worker, console
scripts/dev.sh up
open http://127.0.0.1:3000
```

In the console's Settings, choose a model provider and enter its endpoint and key. This provider drives the engine's filter and chat. The console's `llm` agents need an OpenAI-compatible endpoint and key. Only agents with the `claude-code` runtime use your local Claude Code login. Then tick the markets and timeframes you want to watch.

## Check the desk

The desk lists every watched market. Each card shows the live price, a strip of recent candles, the bot state, the agents, the last signal and the age of its data. Star a market to keep it at the top, and pick a small, medium or large tile.

![The desk with its watched markets.](screen:desk "You can filter the desk by market type, or show only markets with a bot or agent on.")

## Open a market

The instrument page shows the live chart with the supertrend line, each flip, volume and news markers. The table below it lists every signal with the filter's verdict and reason. The right column holds the advisory prediction, the agents, the copilot chat and the latest headlines. You can zoom the chart along its time axis.

![The WTI M5 instrument page.](screen:instrument "Live candles, signals with their verdicts, agents and news on one page.")

Each ◆ below a candle marks news that arrived during that candle. A red ◆ includes an escalation. Hover a candle to see its open, high, low and close, the supertrend, any flip or paper trade on it, and up to three of its headlines with their source.

![The WTI M5 chart with a candle tooltip that lists three headlines.](screen:chart-news "Hovering a candle with a news marker shows its prices, the supertrend and the headlines from that candle.")

## Read the news

The news card on the instrument page shows headlines in English and only those that can move this market. The model translates each headline, judges its relevance and summarizes the article, and the console keeps those results. The card opens on escalations, and you can switch to all relevant headlines. Hover a headline to read its summary.

![The news card for WTI.](screen:news "Each headline names its source and shows whether it was translated, summarized or flagged as an escalation.")

The free news stack needs no key: Google News, GDELT, Al Jazeera, OilPrice.com and Yahoo Finance. For fresher articles, add a [NewsAPI.ai](https://newsapi.ai) key in the News provider tab of the engine dashboard's settings (⚙) and adjust its request budget. The engine fetches NewsAPI.ai when it filters a fresh signal, when a bot deliberates and when you ask the copilot chat for news, and falls back to the free stack when the budget is used up. Set the NewsAPI.ai mode to `auto`, `shadow` or `off` in the same tab or on the console Settings page. In `shadow` the engine records the articles but keeps them out of prompts. GNews is a second provider and stays off until you enable it.

## Ask for a prediction

The prediction card on the instrument page asks a paid prediction provider whether to enter long, short or not at all on the current candle, judged over the next 3 candles. It shows the three probabilities, the confidence, a setup quality score and earlier runs. Press "Predict now", or tick "Auto-update" to run it on each new candle while the console tab is visible. A tab that comes back from the background runs once to catch up. Predictions run on M1, M5, M15, M30, H1 and H4.

![The prediction card for WTI M5.](screen:prediction "One prediction with its probabilities, setup quality and the warning that it has no demonstrated edge.")

Prediction is off by default. Enter the provider key and switch it on in the "Prediction model" card on the console Settings page. Every run is a paid provider call. The prediction is advisory: the bots, the alert filter and the notifier never read it. When an auto-updated prediction flips between long and short, the visible console tab can send a desktop notification. This needs the browser's notification permission and the "Prediction flips between long and short" option under "Desktop notifications from this console" on the Settings page. In a historic backtest these predictions were not more accurate than chance, so treat a prediction as one input among others.

## Ask the copilot

The copilot chat sits on every instrument page. It is the engine's trading copilot on your configured model provider. Each question carries the current view: the quote, the candles, the signal history, your notes, your trader memory and the bot's results. The copilot can widen that context with tools: FXEmpire articles, the breaking-news feed (with NewsAPI.ai when it is configured), Truth Social posts and live rates. Its answers link the articles it used.

![The copilot chat on the WTI page, answering with linked headlines.](screen:chat "The copilot ties fresh headlines to the chart and the last signal, with links to each article.")

Conversations are saved per market, so you can reopen one later. The copilot can save a strategy, memory or gate-prompt draft for you, but a draft never takes effect on its own. You activate it yourself.

## Ask an agent

Press "Check this one now" on an agent, or "Check all now" to ask every model agent of the market. The console freezes the current state and asks the agent whether its strategy's entry conditions hold, and the answer arrives within seconds. The run page shows every tool call, every model round and the result of the deterministic checks.

![A finished run.](screen:run "The run page shows whether the agent chose hold or open, and why.")

The Runs page lists every run. Above the list it shows how many workers are online and a pipeline health card with the queue, the leases, the last monitor pass and the model spend of the day. The Portfolio page shows the paper account, its open positions and its closed trades.

![The Runs page with the pipeline health card.](screen:runs "Queue age, leases, cancel requests, the last monitor pass and the model spend of the day, above the list of runs.")

## Refine a strategy

A strategy is a versioned prompt. You can edit it, compare it with an earlier version or refine it with the grill. The guided grill asks one question at a time and marks a recommended answer. The automatic grill replays past signals and reports which settings held up on data it did not tune on.

![The strategy editor.](screen:strategies "Each save creates a new version, and nothing changes until you press save.")

## Follow the alerts

The alerts page puts signals, agent proposals and paper trades on one time line. A desktop notification opens the matching instrument page.

![The alerts page.](screen:alerts "Signals and other alerts in time order.")

## Keep it local

Market Signals trades paper money only, and agents can only propose. Keep the console on your own machine, because remote access has no authentication yet.
