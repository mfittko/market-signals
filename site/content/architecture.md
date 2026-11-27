---
title: Architecture · Market Signals
description: Four layers with one job each. A deterministic engine, an agent control plane, a rule-based position monitor and a live console.
---

# Four layers, one writer each

<p class="lede">Each layer has one job, and each kind of state has exactly one component that may change it.</p>

<div class="layers">
<div class="layer engine"><b>Engine (Node, SQLite)</b><span>Reads candles, detects trend flips and volume impulses, filters alerts, keeps the live paper book and runs the paper bots. It owns signals, the live paper book and the spend of its own model calls. It is end of life, and Go takes over its jobs one by one.</span></div>
<div class="flow">sends a frozen snapshot at every decision point</div>
<div class="layer"><b>Control plane (Go, Postgres)</b><span>Queues work, leases each run to one worker with a fencing token and records every step. Workers may call a short allowlist of read tools, scoped to one instrument. Every paid model call the control plane makes goes through one gateway with a deadline, a circuit breaker and a daily spend cap. The health route names degraded parts, and a watchdog sends a notice when one lasts ten minutes.</span></div>
<div class="flow">agents return a proposal with reasons</div>
<div class="layer guard"><b>Position monitor (rules only)</b><span>Manages each advisory position on completed bars with stops, targets, trailing stops, time limits and the kill switch. It wakes the agent when a tripwire fires, and the agent may then hold, close or tighten the stop.</span></div>
<div class="flow">streams durable events to the browser</div>
<div class="layer ui"><b>Console (Next.js)</b><span>Shows the desk, instrument charts, the paper portfolio, runs with their audit trail and queue health, positions, strategies, alerts and settings, and updates them live.</span></div>
</div>

## The engine keeps the money

The engine owns the live paper book until the cutover. Go already has its own paper ledger on Postgres. Each write runs in one transaction with an idempotency key, and a replay judges every completed bar once. An import copies the Node book and reports each difference. No bot books on the Go ledger yet, and the platform has no route that writes to either ledger. The bots switch to the Go ledger in v0.11.0, after a reconciled import.

## Every run sees frozen data

The control plane stores the snapshot once, at the moment the signal fires. A run reads that snapshot and nothing newer, so a later candle can never change an earlier decision. We can replay any run and compare agents with bots on equal terms.

## A stale worker cannot commit

One worker holds a run at a time. When a worker stops, its lease expires and another worker picks the run up. The control plane rejects any write from the old worker, because its fencing token no longer matches.

## Models stay out of the exit loop

A model call takes seconds, costs money and sometimes fails. The monitor checks every bar for free and calls the model only when a tripwire fires. If that call fails, the position keeps its stop.

## One run, from flip to position

1. A trend flips on WTI M5. The engine records the signal and sends a snapshot with candles, indicators, news, the bot state and the active strategy.
2. The control plane stores the snapshot and queues one run for each agent that watches the market.
3. A worker leases a run. A model agent reads the snapshot through the tool gateway and may request more context within one budget for the whole run. A Claude Code agent gets a summary of the snapshot and decides in one round, without tools.
4. The agent proposes to hold, or to open with an exit plan. Deterministic checks validate the proposal, and an invalid one becomes a hold.
5. An accepted open becomes an advisory position, and the monitor manages it from then on.

![A run page with the snapshot chart, the audit trail and the proposal.](screen:run "A finished run with its frozen chart, every tool call and model round, and the checked proposal.")

## Technology

| Area | Choice | Reason |
|---|---|---|
| Control plane | Go, standard library router, hand-written SQL on Postgres | Small and easy to read during an incident |
| Live updates | Server-sent events from a durable event log | A reconnect resumes from the last event |
| Agents | A bounded tool loop with any OpenAI-compatible model, or the local Claude Code CLI without tools | Each call has a deadline and a circuit breaker, and paid calls stop at a daily spend cap |
| Console | Next.js with plain CSS | One set of design tokens for light and dark |
| Storage | Postgres for the platform, SQLite in the engine until cutover | Each domain has one writer during every step of the move |

Postgres row locks and leases run the queue, so the system needs no Redis and no message broker at this scale.

## Moving the domain to Go

In November 2026 we decided to retire the Node engine. It gets no new features, and the Go control plane takes over every job it does today. We move one job at a time, and each Go part runs next to the engine as a mirror or in shadow before it takes over. The paper ledger, the settings store and the strategy store already exist in Go. Console strategy edits already write to the Go strategy store. The engine stays the writer of the paper book, the settings and its own strategy versions until the switch. After the cutover in v0.13.0, agents earn authority on the Go side. The [Node cutover epic](https://github.com/mfittko/market-signals/issues/345) holds the plan, under the [stack migration epic](https://github.com/mfittko/market-signals/issues/229).
