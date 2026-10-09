import sys, os, glob, json, pickle
import pandas as pd
A = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
for c in sys.argv[1:]:
    print("=====", c)
    for f in sorted(glob.glob(os.path.join(A, c, "out", "*.pkl")))[:3]:
        o = pd.read_pickle(f)
        print("PKL", os.path.basename(f), type(o).__name__)
        if isinstance(o, pd.DataFrame):
            print("  cols", list(o.columns)[:60], len(o))
        elif isinstance(o, dict):
            for k, v in list(o.items())[:12]:
                print("  key", k, type(v).__name__, (list(v.columns)[:40], len(v)) if isinstance(v, pd.DataFrame) else (getattr(v, "shape", None) or (len(v) if hasattr(v, "__len__") else v)))
    for f in sorted(glob.glob(os.path.join(A, c, "out", "*.json")))[:2]:
        j = json.load(open(f))
        def walk(x, p="", d=0):
            if d > 3: return
            if isinstance(x, dict):
                ks = list(x.keys()); print(" " * d + p, "dict", ks[:25])
                if ks: walk(x[ks[0]], ks[0], d + 1)
            elif isinstance(x, list):
                print(" " * d + p, "list", len(x))
                if x: walk(x[0], "[0]", d + 1)
        print("JSON", os.path.basename(f)); walk(j)
