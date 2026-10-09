"""Build compact per-instrument M5 bid/ask bars (de_v2.build: production supertrend ATR/flip, spread ratio) and M1 mid
closes, read-only from history.db. Output: cache/<INST>.npz. Usage: python prep.py INST [INST ...]"""
import os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
ENG = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, ENG)
import numpy as np  # noqa: E402
import de_v2 as de  # noqa: E402
from bars import load_m1, coverage  # noqa: E402

KEEP = ["t", "volume", "atr", "flip", "spr", "day"] + [f"{s}_{k}" for s in ("bid", "ask", "mid") for k in "ohlc"]
os.makedirs(os.path.join(HERE, "cache"), exist_ok=True)
for inst in sys.argv[1:]:
    de.prefetch(inst)
    n, a, b = coverage(inst)
    m1 = load_m1(inst)
    B = de.build(inst, m1)
    out = {k: B[k] for k in KEEP}
    out["m1_t"] = m1["t"]; out["m1_c"] = (m1["bid_c"] + m1["ask_c"]) / 2
    np.savez(os.path.join(HERE, "cache", inst.replace("/", "_") + ".npz"), m1_rows=n, m1_first=a, m1_last=b, **out)
    print(inst, n, a, b, len(out["t"]), "M5 bars", flush=True)
