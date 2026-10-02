---
title: Market Signals
description: A signal desk for one trader. Agents advise on each alert and rules guard every paper position. The goal is to follow a market move from its first alert to its end.
---

<span class="chip">Advisory prototype · paper money only</span>

# Follow every move to its end.

<p class="lede">Market Signals is a signal desk for one trader. It alerts you when a move starts. Agents read the context and advise you, and plain rules manage every open paper position. The goal is a desk that keeps watching while the move runs and tells you when it is over.</p>

<div class="btns"><a class="btn primary" href="guide.html">See it in use</a><a class="btn" href="architecture.html">How it is built</a></div>

![The desk shows every watched market, its bot state and its last signal.](screen:desk "The desk lists each watched market with its bot state, last signal and data freshness.")

## Alerts end too early

A typical alert fires when a trend line flips or volume spikes, and then it says nothing more. You have to find out yourself whether the move held, reversed two minutes later, or was noise. That follow-up decides most outcomes.

We saw this on a real morning in October 2026. Oil rose three dollars in two hours. The alerts fired at the start and stayed silent through an hour of steady gains, and the system recorded the first reversal as a duplicate and sent nothing.

## A watch with an ending

Market Signals will treat a signal as the start of a watch. The watch will report when the move continues and when it reverses or fades, and then it will close with one clear message. This is the goal of v0.4.0.

<div class="cards">
<div class="card"><strong>Agents advise</strong><p>An agent reads the chart, the indicators, the news and your written strategy, then proposes a trade with its reasons. You decide.</p></div>
<div class="card"><strong>Rules handle exits</strong><p>Stops, targets, trailing stops, time limits and the kill switch run as plain code on every completed bar.</p></div>
<div class="card"><strong>Authority is earned</strong><p>Agents get more responsibility only after they beat the existing bots on matched data, against thresholds we fix before the test.</p></div>
<div class="card"><strong>Your machine, your data</strong><p>Everything runs locally, with your own keys and your own market data.</p></div>
</div>

## Six rules we keep

1. Agents propose and the trader decides. Authority grows in steps: advise, compare, execute on paper, and finally opt in per bot with an immediate off switch.
2. Exactly one component writes each kind of state: the paper book, alerts, strategies and settings.
3. A failed model call means hold, and the stop stays in force. A failed alert filter still lets the alert through.
4. The console names missing or late data in plain words and shows no guessed values.
5. A headline can raise attention, but it never sets a trade direction.
6. Every trade uses paper money.

## Road to 1.0

A working prototype runs every day in advisory mode. Version numbers stay below 1.0 until the system is stable.

| Version | Goal |
|---|---|
| v0.2.0 | Ship the advisory foundation |
| v0.3.0 | Use it daily on one machine |
| v0.4.0 | Alerts that follow a move through |
| v0.5.0 | Evidence and a research baseline |
| v0.6.0 | Opt-in paper execution |

The milestones and their issues are public on [GitHub](https://github.com/mfittko/market-signals/milestones).
