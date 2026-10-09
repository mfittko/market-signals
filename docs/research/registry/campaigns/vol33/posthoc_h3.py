"""POST-HOC (after the vol33 outcomes): H3 with the range scaled by ATR(10) at bar i-1, so the spike bar's own true range
does not inflate the denominator. Same spike/normal groups, hour matching and bootstrap. Never decides anything."""
import os, sys, json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np  # noqa: E402
import vol33 as V  # noqa: E402

out = []
for tf in ("M5", "M1", "M15"):
    for inst in V.INSTS:
        B, F = V.feats(inst, tf)
        _, base = V.signals(B, F)
        B2 = dict(B); B2["atr"] = np.r_[np.nan, B["atr"][:-1]]
        res = V.h3(B2, F, base, V.range12(B2, int(B["step"])), V.win(B["t"]), V.day_of(B["t"]))
        out.append(dict(inst=inst, tf=tf, H3_prevATR=res))
        print(tf, inst, " | ".join(f"{w} q98 {res[w]['q98.0']['ratio']:.3f} [{res[w]['q98.0']['ci'][0]:.3f},{res[w]['q98.0']['ci'][1]:.3f}]"
                                   for w in V.WINS), flush=True)
        V._log(dict(exp="vol33", cell=f"POSTHOC|{tf}|H3_prevATR", unit=V.TAG(inst), primary=False, posthoc=True, h3=res))
json.dump(out, open(os.path.join(V.OUT, "posthoc_h3.json"), "w"), indent=1, default=float)
