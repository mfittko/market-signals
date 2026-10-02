---
title: Introducing Market Signals
description: Why we are building Market Signals. Alerts that follow a move to its end, agents that advise, and plain code that guards every position.
---

# Introducing Market Signals

<p class="lede">A signal desk for one trader. It tells you when a move starts, follows it, and tells you when it is over. Agents advise. Plain code guards every position. Nothing trades with real money.</p>

## The gap

Alerts stop at the trigger. A trend line flipped. Volume spiked. Then you are on your own. You do not learn whether the move held, whether it reversed two minutes later, or whether it was noise.

We saw this on a real morning. Oil rose three dollars in two hours. The alerts fired at the start, then fell silent for an hour of steady gains. A reversal at the very beginning was swallowed as a duplicate. The information existed. The system did not follow the move.

Bots have the opposite problem. A bot that acts on a one-line trigger is fast and brittle. A language model can read the context around a trade, but it should not have a hand on the money.

## The idea

Give each job to the part that does it best.

- **The engine** reads candles, finds signals and keeps the books. It is deterministic and tested.
- **Agents** read the context around a signal: the chart, the indicators, the news and your written strategy. They explain and propose. They advise.
- **Plain rules** manage everything that is open: stops, targets, trailing, time limits and a kill switch.

The goal is simple to state. Never miss the course of a move. A signal should open a watch that ends with a clear message: the move continued, it reversed, or it faded.

## Earning authority

Agents start as advisors. They become more only by evidence.

1. **Advise.** Agents propose next to the existing bots. Nothing changes in the books.
2. **Compare.** Agent proposals and bot decisions are scored on the same events, with thresholds fixed before the results exist. Missing or late data counts against the agent.
3. **Execute on paper.** A narrow, idempotent engine route lets an agent place paper trades within strict caps.
4. **Opt in.** One bot at a time, at the smallest size, with a switch that turns it off at once.

There is no step five with real money in the plan.

## How it is built

A Node engine owns signals and the paper book. A Go control plane on Postgres queues work, leases it to workers and records every step. Workers call only an allowlist of read tools. A Next.js console shows it all and updates live. The [architecture page](architecture.md) explains each layer and why it exists.

The project is built with [dev-loops](https://mfittko.github.io/dev-loops/). Every change passes review gates before it merges.

## Where it stands

The prototype runs every day in advisory mode. Alerts, charts, agent runs, strategy authoring and a position monitor with tripwires work today. The [guide](guide.md) shows a day at the desk.

Market Signals gives no financial advice and makes no claim about returns. Trading carries risk. This is software built in the open, and it is built to be honest about what it knows.
