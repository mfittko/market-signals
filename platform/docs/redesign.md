# Redesign around agents, position watching and data migration

Status: proposal on the spike branch. Nothing here is merged.

## 1. Position watching: poll deterministically, wake the model on exceptions

The answer to "should an agent poll while in a position" is yes, with one rule: a deterministic monitor does the polling, and the model wakes only when a tripwire fires.

What the old bot does today (scripts/bot.mjs):
- Every cycle, without a model: simulate stop and target fills on the completed candle, mark to market, check the drawdown kill switch.
- The model deliberates only on a fresh flip, a volume impulse, or an adverse move past one percentage threshold.
- After the model opens a position, it has no way to say what should wake it later. The stop is static until an event happens.

The gap: the wake conditions are fixed and global. The model cannot express "wake me if price closes above 93.4" or "I expect follow-through within 6 bars, wake me if there is none".

### The design: plan at entry, enforce deterministically, wake on exception

1. When the model opens a position, its proposal carries an exit plan, next to stop and target:
   - `stop`, `target` (already exist)
   - `invalidation`: a condition that voids the trade idea
   - `trail`: a deterministic trailing rule (for example the Supertrend line, or N times ATR)
   - `max_bars`: time stop
   - `tripwires`: a list of declarative wake conditions
2. Tripwires are declarative data with a small, fixed vocabulary:
   - `close_beyond(level)`, `price_cross(level, dir)`
   - `adverse_pct(x)`, `adverse_atr(x)`
   - `bars_in_trade(n)` without progress toward target
   - `opposite_flip`, `impulse`
   - `news_escalation` (the sentinel flag). Not wired yet. The monitor never reads the sentinel, so a plan
     accepts this tripwire and it never fires.
   - `feed_stale(minutes)`
3. A monitor loop in the control plane evaluates the plan on every closed M1 candle for an open position. It calls no model. It does four things:
   - Fills stops and targets with the existing pessimistic rule (stop wins when both touch).
   - Applies the trailing rule. A stop may only move toward price.
   - Enforces the time stop and the kill switch.
   - Raises a wake event when a tripwire fires.
4. A wake event creates a normal run with a reason (`tripwire:adverse_atr`), a fresh immutable snapshot that includes the position and its plan, and a dedup key of position id plus tripwire. The model is then restricted to four actions: `hold`, `close`, `tighten_stop(new_stop)`, `set_tripwires(list)`.
5. Limits that keep it cheap and safe:
   - A cooldown per tripwire and a budget of wakes per position and per day.
   - If the model fails, times out or returns garbage, the result is `hold`. The deterministic stop is still in force.
   - Three failed wakes in a row raise an attention item for the operator.
   - The model cannot widen a stop, add size or open in the opposite direction from a wake. Those need a normal entry run.

Why this shape: cost stays flat while a position is quiet. The deterministic monitor owns the safety-critical part (stops, fills, kill switch). The model writes the tripwires that make its own thesis testable.

Shadow proof: in shadow mode the monitor runs against the old engine's positions and logs which tripwires would have fired. Compare that with the old bot's actual review events before anyone trusts it.

## 2. What to keep and what to drop

Evidence: the feature inventory of the old app, plus the app's own ux-redesign-plan (26 findings). The repo has no usage telemetry, so "used" means code size, tests and README emphasis.

Keep, and make central:

| Feature | Why |
|---|---|
| Chart with Supertrend and flip markers | The product's face. Already rebuilt as the run chart. |
| Signal history with realized outcomes | Honest track record per signal. |
| Filter verdict on each flip | The model sanity check is the point of the tool. |
| Paper-trading bots with fail-safe holds | Becomes the agent model. |
| Virtual portfolio, halt and reset | Keep, with one source of truth. |
| Chat copilot | Keep, scoped to the object on screen. |
| Multi-instrument switching | Becomes the instrument registry. |
| Health strip | Becomes the attention queue. |
| Scheduler and keep-fresh | Becomes the ingest jobs. |

Keep and reshape:

| Feature | Change |
|---|---|
| Strategies (versioned prompt plus spec) | Keep versions. Drop the name-binding and per-combo scope machinery. An agent points at one strategy version. |
| Memories and notes file | Two stores for one idea. Merge into one store of standing rules with scope: global, instrument or agent. |
| Gate prompts | Merge into the agent's versioned prompt. Two of four gates were editable, which is an unfinished feature. |
| Volume impulse lane | Becomes a trigger type that agents subscribe to. The separate impulse signal kind goes away. |
| Evaluation and baselines | Keep. It is how strategy versions get compared. Move it next to the version list. |
| Indicators beyond Supertrend | Keep as chart layers, off by default. |

Drop:

| Feature | Reason |
|---|---|
| A bot rail, overview bots and topbar portfolio chips | The same position is drawn five ways in five places. |
| Chart endpoint that writes data | A read must not mutate. Replace with an explicit ingest job. |
| Lazy backfill when browsing | Legacy workaround. The old plan lists it as a bug. |
| GNews provider | The README calls its free key a stale feed that looks live. Keep NewsAPI.ai and the free feeds. |
| Speech to text mic | Needs a second key. Peripheral. Revisit only if you use it. |
| Provider migration code for old settings | Not needed once data is imported once. |
| The manual supertrend CLI cycle | It can double-run a cycle. One owner: the scheduler. |
| Trump, Hormuz and briefing skills as dashboard features | Keep them as agent tools only. |
| The 900px-only mobile layout | Rebuilt mobile-first. The old one clips tables and hides chat. |

Add, because it is missing:
- A command palette (no global shortcuts exist today).
- An attention queue: halted bot, failing feed, agent and engine disagreement, draft strategy waiting for activation.
- A visible "why is it not doing anything" line on every agent.

## 3. Information architecture

The new UI is organised around the agent, because the agent is what the user manages.

1. Desk (home). One row per agent, grouped by instrument. Each row shows state (flat, watching a position, halted, waiting), profit and loss, last decision and the next wake reason. Above the rows sits the attention queue.
2. Agent page. State header, chart with the position plan drawn on it (stop, target, trail, tripwires), a timeline of runs, watch ticks and wakes, the strategy version with its record, and controls: pause, switch between shadow and paper, force a review.
3. Run page. Exists. Full audit trail of one decision.
4. Instruments. The registry. Enabling an instrument creates agents from a strategy template. Each instrument shows regime, feed health and its agents.
5. Performance. One page and one source of truth for equity, positions, trades and per-strategy-version results including baselines.
6. Copilot. A side panel on every page. It knows the object on screen (agent, run or instrument). It uses the same read tools as agents through the same gateway. It can propose changes such as a draft strategy or a standing rule. A human activates them. Backends: Claude Code, API providers, pi.
7. Settings. Three tabs: providers, data sources and notifications.
8. Research (later). Backtests and autonomous campaigns, fed by the same data.

## 4. More instruments

Today a platform agent is bound to one instrument (WTICO/USD) and the tool gateway scopes reads to it. The old engine tracks many.

- Add an `instruments` table seeded from `config/instruments.yaml` and `config/candle-symbols.json`.
- An agent is (instrument, granularity, strategy version, runtime). The scope check already keys on the agent's instrument, so isolation carries over.
- Enabling an instrument in the UI creates its agents from a template. The bot map in `data/settings.json` gives the initial set.
- The engine hook already sends per-instrument snapshots. No engine change is needed.

## 5. Data migration

Source: `data/candles.db` (191 MB). It holds every table.

| Table | Rows | Destination |
|---|---|---|
| candles | 718,437 across many instruments and M1, M5 and other granularities | `candles`, keyed by instrument, granularity, time |
| signals | 8,028 | `signals` with kind (flip or impulse) |
| signal_snapshots | 5,462 | immutable `snapshots`, tagged legacy |
| strategies | 22 rows, 14 distinct names | `strategies` with versions kept, active pointer per agent from the bot map |
| bot_trades | 48 | `positions` and `fills` |
| bot_journal | 3,108 | legacy run history, read-only, shown on the agent timeline |
| portfolio, bot_state | 1 each | opening balance and peak equity |
| chat_threads, chat_messages | 118 and 592 | copilot threads |
| memories, gate_prompts | 5 and 1 | standing rules and prompt versions |
| signal_rechecks | 8 | run history |
| news, news_provider_observations, articles | 66k, 23k, 1k | news: last 30 days only. Observations and articles: skip. |

Rules for the importer:
1. Read-only. Open a copy of the file and leave the live one untouched.
2. Idempotent. Every imported row carries a `source_key` with a unique constraint, so a re-run only adds new rows. This also lets the importer run repeatedly until cutover.
3. Dry run first. It prints counts per table and the invariants below, and writes nothing.
4. Invariants it must prove before it commits:
   - Row counts match per table and per instrument.
   - Trade profit and loss recomputed from fills equals the old total.
   - Equity recomputed from the opening balance and closed trades matches the old portfolio row.
   - Every strategy version referenced by a trade exists after import.
5. Imported history is immutable and marked `legacy`, so nobody mistakes it for an agent decision.

## 6. Build order

| Step | Content | Effort |
|---|---|---|
| 1 | Instruments table, agent per instrument, instrument switcher, seeded from config | 1 day |
| 2 | Importer dry run with the invariants above, candles and signals first | 1 to 2 days |
| 3 | Importer for strategies, trades, journal, chat, standing rules | 1 to 2 days |
| 4 | Desk and agent pages, attention queue | 2 to 3 days |
| 5 | Exit plan in the proposal schema, monitor loop, tripwire evaluator, wake runs, in shadow mode | 3 to 4 days |
| 6 | Performance page, copilot panel with Claude Code backend | 2 to 3 days |
| 7 | Shadow comparison of tripwires against the old bot's review events | calendar time while shadow data accumulates |

Steps 1 to 3 are safe to build now. Step 5 is the design decision to confirm before building.
