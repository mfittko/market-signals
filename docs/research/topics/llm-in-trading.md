# LLMs in trading

Question: can a large language model call direction, filter signals or explain the market usefully?

Answer: as a direction caller or as a signal filter, no evidence supports it here or in the literature. The external review assigns LLMs a narrower role: auditable extraction of event facts, measured for accuracy, with price confirmation still required. That role is untested.

## Our evidence

| Test | Design | Result | Grade |
|---|---|---|---|
| [filter316] | The live LLM alert filter's allow and suppress verdicts on 5,455 flips (2026-07-22 to 2026-10-08), scored as if traded | Allowed -0.276 R [-0.373, -0.167], suppressed -0.288 R [-0.339, -0.236]. The filter suppresses 82% and sits at the 59th percentile of random thinning. No reason category passes; all Holm p at least 0.41. | B |
| Model lab, 2026-10-07 | TypeSafe Jev prompts vs local models on 11 weeks of `candles.db` (2026-07-20 to 2026-10-07), held-out time | The production prompt's log loss is 42 to 54% worse than the base rate. Directional hit 51.7% (228 of 441) on new bars, pooled 53% [49%, 57%]. As a big-move scorer Jev reaches AUC 0.50 to 0.59 against about 0.60 for the local model. | D (not preregistered, short sample) |
| Spike 4, big-day scorer at 10:00 UTC over 150 days | Local model vs Jev vs DeepSeek-V4.1-Flash vs a naive excursion ratio | AUC 0.76, 0.68, 0.68 and 0.69. | D |
| news28 | Jev as a relevance labeller for GDELT rows | 8,583 calls, no rate limits, batches of 100 work. Used to measure rule precision (0.12 to 0.54), not to trade. Closed by operator decision. | D |

The filter's reasons are mostly about position in the range ("at session high or low", "extended"). Only 102 of 2,752 "late chasing" texts say "late" or "chase" literally ([filter316]). Mechanical versions of the same reasons (chase after a burst, move already stretched) are harmful filters in [notrade12].

## External evidence

- TradingAgents reports +23 to +27% over about 3 months on three US stocks, with no costs. An independent check found its AAPL buy-and-hold baseline wrong: +9.12%, not -5.23%. Grade D.
- FINSABER finds that LLM strategies lose their reported advantage over 20 years and 100+ symbols. Grade C.
- ai-hedge-fund makes no trades and is educational. OctoBot's LLM mode has no published evidence.
- FinRL's authors name backtest overfitting as a core problem of deep RL trading.

See [sources.md](../sources.md#llms-and-machine-learning-in-trading).

## The extractor-only stance

The external review (https://github.com/mfittko/market-signals/issues/310#issuecomment-6084872152) proposes:

- Do not return to "candles plus indicators to long, short or no trade".
- Use an LLM to extract event facts: event type, affected instruments, announced quantity, change from the prior statement, effective date, new fact or repetition, source evidence, first-available time and extraction uncertainty.
- Validate extraction accuracy on a reviewed sample. Check numeric fields deterministically.
- Ask whether these facts add information after controlling for the observed price response. A persuasive explanation is not a result.
- Semantic similarity between events is not evidence of similar future returns.

Current product rule: an LLM may explain, never decide. News and LLM output never set direction, and price confirmation is mandatory before any entry.

<!-- campaign link definitions -->
[filter316]: https://github.com/mfittko/market-signals/issues/316#issuecomment-6055138146
[notrade12]: https://github.com/mfittko/market-signals/issues/310#issuecomment-6054177967
