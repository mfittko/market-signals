"""Diagnostic (no outcomes): fit-sample rows by UTC hour vs entries by hour.  python diag_hours.py INST"""
import os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
inst = sys.argv[1]
sys.argv = [sys.argv[0], "diag", inst]
import risk8 as K  # noqa: E402
from risk8 import np, A, de  # noqa: E402

B, O, X, S = K.load(inst)
u = A.utc_close(B)
print("fit rows by hour", np.bincount(u[S["i"]] // 60, minlength=24).tolist())
cad = (u % 30 == 0)
print("cadence bars by hour", np.bincount(u[cad] // 60, minlength=24).tolist())
m = cad & de.base_active(B, O)
print("cad&active by hour", np.bincount(u[m] // 60, minlength=24).tolist())
m2 = m & (B["spr"] <= de.SPR_MAX)
print("cad&active&spr by hour", np.bincount(u[m2] // 60, minlength=24).tolist())
m3 = m2 & np.isfinite(X).all(1)
print("+finite X by hour", np.bincount(u[m3] // 60, minlength=24).tolist())
