---
title: Architecture · Market Signals
description: Four layers with one job each. A deterministic engine, an agent control plane, a rule-based position monitor and a live console.
---

# Architecture

<p class="lede">The system has four layers. Each layer has one job, and each piece of state has exactly one writer.</p>

<div class="layers">
<div class="layer engine"><b>Engine (Node, SQLite)</b><span>Reads candles, detects trend flips and volume impulses, filters alerts, keeps the paper book and runs the existing paper bots. It owns signals, the ledger and spend budgets.</span></div>
<div class="flow">sends a frozen snapshot at every decision point</div>
<div class="layer"><b>Control plane (Go, Postgres)</b><span>Queues work, leases each run to one worker with a fencing token, records every step and replays nothing twice. Workers call only a short allowlist of read tools, scoped to one instrument.</span></div>
<div class="flow">agents return a proposal, never an order</div>
<div class="layer guard"><b>Position monitor (rules, no model)</b><span>Manages every advisory position on completed bars: stops, targets, trailing, time stops and the kill switch. It wakes the agent only when a tripwire fires, and the agent may only hold, close or tighten.</span></div>
<div class="flow">streams durable events over server-sent events</div>
<div class="layer ui"><b>Console (Next.js)</b><span>Desk, instrument charts, runs with their full audit trail, positions, strategies, alerts and settings. Updates arrive live without a reload.</span></div>
</div>

## Why it is split this way

**The engine stays in charge of money.** It already works and it is tested. The new platform reads from it and advises next to it. It cannot write to the paper book.

**Snapshots are frozen.** A run sees exactly the data that existed when it was queued. A later candle never leaks into an earlier decision. That makes every run replayable and every comparison fair.

**Work is leased and fenced.** A run belongs to one worker at a time. If a worker stops, its lease expires and another worker takes over. A stale worker cannot commit, because its fencing token no longer matches.

**Exits are plain code.** A model is slow, it costs money and it can fail. The monitor handles routine work on every bar for free. The model is called only when something unusual happens, and a failed call leaves the stop in place.

## A run, step by step

1. A trend flips on WTI M5. The engine records the signal and sends a snapshot: candles, indicators, news, the bot state and the active strategy.
2. The control plane stores the snapshot once and queues one run per agent watching that market.
3. A worker leases a run. The agent reads the snapshot through the tool gateway and may ask for more context within its budget.
4. The agent returns a proposal: hold, or open with an exit plan. Deterministic checks validate it. An invalid proposal becomes a hold.
5. An accepted open becomes an advisory position. From here the monitor owns it, bar by bar.

![A run page with the snapshot chart, the audit trail and the proposal.](screen:run "A run. The frozen chart, every tool call and model round, and the final proposal with its checks.")

## Technology choices

| Area | Choice | Reason |
|---|---|---|
| Control plane | Go, standard library router, plain SQL on Postgres | Small, fast and easy to read at 3am |
| Live updates | Server-sent events from a durable event log | One direction is enough, and reconnects resume from the last event |
| Agents | A native tool loop with any OpenAI-compatible model | Pluggable runtimes come after the baseline is measured |
| Console | Next.js and plain CSS | One design token set for light and dark |
| Storage | Postgres for the platform, SQLite in the engine until cutover | One writer per domain at every step, then one database |

There is no Redis and no message broker. Postgres row locks and leases cover the queue at this scale.

## What comes next

The engine stays the owner of money until agents prove themselves on matched data. The domain then moves to Go in bounded slices, each one shadowed against the Node engine before it takes over. The full plan lives in the [stack migration epic](https://github.com/mfittko/market-signals/issues/229).
