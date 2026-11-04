"""Build per-instrument M1/M5/M15 bid/ask bars with production ATR and supertrend flip, read-only from history.db,
plus the price/volume event candidates (no outcomes). Output: cache/<INST>_<TF>.npz.
Usage: python prep.py INST [INST ...]"""
import os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
ENG = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, ENG)
import numpy as np  # noqa: E402
import de_v2 as de  # noqa: E402
from bars import load_m1, resample, MIN  # noqa: E402

KEEP = ["t", "volume", "atr", "flip"] + [f"{s}_{k}" for s in ("bid", "ask", "mid") for k in "ohlc"]
if __name__ == "__main__":
    for inst in sys.argv[1:]:
        de.prefetch(inst)
        m1 = load_m1(inst)
        for tf in ("M1", "M5", "M15"):
            B = m1 if tf == "M1" else resample(m1, tf)
            if tf == "M1":
                B = dict(B)
                for k in "ohlc":
                    B["mid_" + k] = (B["bid_" + k] + B["ask_" + k]) / 2
            S = de.supertrend(inst, B)
            out = {k: B[k] for k in KEEP if k not in ("atr", "flip")}
            out["atr"] = S["atr"]; out["flip"] = np.nan_to_num(S["flip"]).astype(np.int8)
            np.savez(os.path.join(HERE, "cache", f"{inst.replace('/', '_')}_{tf}.npz"), step=MIN[tf], **out)
            print(inst, tf, len(out["t"]), flush=True)
