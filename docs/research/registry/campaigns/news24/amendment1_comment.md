## news24 amendment 1 (pre-outcome): gross primary metric

Operator decision: the spread is the operator's own risk. Registered before any outcome was computed. At this point the GKG fetch held 663 of about 39.7k files, all baseline grid. No event was joined to news and no R was computed.

File: `data/research/engine/audit/news24/amendment_2026-10-08_gross.json` (sha256 prefix `7e6b109394d16f11`). It names the hash of the original prereg and of the amended code.

Changes:
- Primary metric is GROSS. The same simulation and stop definition run on mid prices (bid = ask = mid). Entry stays at the next bar's open, so latency is kept. Gross R at 3, 6 and 12 bars. Continuation rate = share of gross R > 0.
- PASS (WTI M5, 6 bars): the GROSS NEWS mean R CI lies above 0 in both windows AND the GROSS NEWS minus CONTROL CI lies above 0 in both windows.
- Spread-inclusive results (bid/ask fills) are secondary and reported side by side.
- Everything else is unchanged, including the spread <= 0.2 R event filter.

Original preregistration: https://github.com/mfittko/market-signals/issues/310#issuecomment-6060706463
