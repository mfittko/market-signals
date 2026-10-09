"""Evaluator v2, correction D1: the audit v1 fixtures (F1-F10) run against labels_v2.simulate.

F8 must pass. F10 compares the optimistic pass with the ADMISSIBLE reference (ref_one mode "adm"), since mode "hopt"
replicates the v1 defect by construction.

  python fixtures_v2.py     exits non-zero on any failure
"""
import os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
ENGINE = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, ENGINE); sys.path.insert(0, os.path.join(ENGINE, "audit", "v1"))
import fixtures as fx
import labels_v2

_ref = fx.ref_one
fx.simulate = labels_v2.simulate
fx.ref_one = lambda *a, mode="pess", **kw: _ref(*a, mode="adm" if mode == "hopt" else mode, **kw)

if __name__ == "__main__":
    fx.fixtures()
    fails = [n for n, ok, _ in fx.RESULTS if not ok]
    print(f"{len(fx.RESULTS)} checks, {len(fx.RESULTS) - len(fails)} pass; failures: {fails}")
    sys.exit(1 if fails else 0)
