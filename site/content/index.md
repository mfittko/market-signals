---
title: Market Signals
description: A signal desk for one trader. It follows a move from its start to its end. Agents advise, plain code guards every position, and nothing trades with real money.
---

<span class="chip">Advisory prototype · paper money only</span>

# Never miss the course of a move.

<p class="lede">Market Signals is a signal desk for one trader. It tells you when a move starts, follows it, and tells you when it is over. Agents read the context and advise. Plain code guards every open position.</p>

<div class="btns"><a class="btn primary" href="guide.html">See how it works</a><a class="btn" href="architecture.html">Read the architecture</a></div>

![The desk shows every watched market, its bot state and its last signal.](screen:desk "The desk. One row per market, with bot state, last signal and freshness.")

## The vision

Most alerts tell you that something happened. A trend line flipped, or volume spiked. Then the alert goes quiet. You do not learn whether the move held, whether it reversed two minutes later, or whether it was noise. The follow-up decides most outcomes, and alerts skip it.

Market Signals turns an alert into a short story with an ending. A move starts. It continues, it reverses, or it fades. You hear about each step that matters, and you hear when the story is over.

<div class="cards">
<div class="card"><strong>Follow through</strong><p>A signal opens a watch. The watch reports a continuation, a reversal or a fade, and then closes.</p></div>
<div class="card"><strong>Agents advise</strong><p>Agents read the chart, the indicators, the news and your strategy. They explain and propose. They do not trade.</p></div>
<div class="card"><strong>Code guards exits</strong><p>Stops, targets, trailing, time limits and the kill switch run as plain rules. No model sits in that loop.</p></div>
<div class="card"><strong>Evidence first</strong><p>Agents earn authority in steps, against thresholds fixed before anyone sees the results.</p></div>
</div>

## Principles

1. **Advisory before authority.** Agents propose. Authority grows in steps: advise, compare on matched data, execute on paper, then opt in per bot with a fast switch off.
2. **One writer per domain.** Exactly one component may change the paper book, an alert, a strategy or a setting.
3. **Fail safe.** If a model fails, the decision is hold and the stop stays in force. If the alert filter fails, the alert still goes out.
4. **Say what you know.** The console shows missing or late data in plain words and never fills a gap with a guess.
5. **News informs, never directs.** A headline can raise attention. It never sets a trade direction.
6. **Own your data.** It runs on your machine, with your keys and your data.

## Where it stands

A working prototype runs every day in advisory mode, against paper money. Versions stay below 1.0 until the system is genuinely stable.

| Version | Theme |
|---|---|
| v0.2.0 | Ship the advisory foundation |
| v0.3.0 | Daily driver on loopback |
| v0.4.0 | Alerts that follow a move through |
| v0.5.0 | Evidence and a research baseline |
| v0.6.0 | Opt-in paper execution |

The milestones and their issues are public on [GitHub](https://github.com/mfittko/market-signals/milestones). Read [the introduction](introducing-market-signals.md) for the longer story.
