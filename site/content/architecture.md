---
title: Architecture · Market Signals
description: Four layers with one job each. A deterministic engine, an agent control plane, a rule-based position monitor and a live console.
---

# Four layers, one writer each

<p class="lede">Each layer has one job, and each kind of state has exactly one component that may change it.</p>

<div class="layers">
<div class="layer engine"><b>Engine (Node, SQLite)</b><span>Reads candles, detects trend flips and volume impulses, filters alerts, keeps the paper book and runs the paper bots. It owns signals, the ledger and spend budgets.</span></div>
<div class="flow">sends a frozen snapshot at every decision point</div>
<div class="layer"><b>Control plane (Go, Postgres)</b><span>Queues work, leases each run to one worker with a fencing token and records every step. Workers may call a short allowlist of read tools, scoped to one instrument.</span></div>
<div class="flow">agents return a proposal with reasons</div>
<div class="layer guard"><b>Position monitor (rules only)</b><span>Manages each advisory position on completed bars with stops, targets, trailing stops, time limits and the kill switch. It wakes the agent when a tripwire fires, and the agent may then hold, close or tighten the stop.</span></div>
<div class="flow">streams durable events to the browser</div>
<div class="layer ui"><b>Console (Next.js)</b><span>Shows the desk, instrument charts, runs with their audit trail, positions, strategies, alerts and settings, and updates them live.</span></div>
</div>

## The engine keeps the money

The engine already works and has a broad test suite, so it stays the owner of the paper book. The platform reads from it and advises next to it, and it has no route that writes to the ledger.

## Every run sees frozen data

The control plane stores the snapshot once, at the moment the signal fires. A run reads that snapshot and nothing newer, so a later candle can never change an earlier decision. We can replay any run and compare agents with bots on equal terms.

## A stale worker cannot commit

One worker holds a run at a time. When a worker stops, its lease expires and another worker picks the run up. The control plane rejects any write from the old worker, because its fencing token no longer matches.

## Models stay out of the exit loop

A model call takes seconds, costs money and sometimes fails. The monitor checks every bar for free and calls the model only when a tripwire fires. If that call fails, the position keeps its stop.

## One run, from flip to position

1. A trend flips on WTI M5. The engine records the signal and sends a snapshot with candles, indicators, news, the bot state and the active strategy.
2. The control plane stores the snapshot and queues one run for each agent that watches the market.
3. A worker leases a run. The agent reads the snapshot through the tool gateway and may request more context within its budget.
4. The agent proposes to hold, or to open with an exit plan. Deterministic checks validate the proposal, and an invalid one becomes a hold.
5. An accepted open becomes an advisory position, and the monitor manages it from then on.

![A run page with the snapshot chart, the audit trail and the proposal.](screen:run "A finished run with its frozen chart, every tool call and model round, and the checked proposal.")

## Technology

| Area | Choice | Reason |
|---|---|---|
| Control plane | Go, standard library router, hand-written SQL on Postgres | Small and easy to read during an incident |
| Live updates | Server-sent events from a durable event log | A reconnect resumes from the last event |
| Agents | A native tool loop with any OpenAI-compatible model | We measure this baseline before we add other runtimes |
| Console | Next.js with plain CSS | One set of design tokens for light and dark |
| Storage | Postgres for the platform, SQLite in the engine until cutover | Each domain has one writer during every step of the move |

Postgres row locks and leases run the queue, so the system needs no Redis and no message broker at this scale.

## Moving the domain to Go

The engine keeps the money until agents prove themselves on matched data. After that we port the domain to Go in bounded slices, and each slice runs in shadow next to the Node engine before it takes over. The [stack migration epic](https://github.com/mfittko/market-signals/issues/229) holds the plan.
