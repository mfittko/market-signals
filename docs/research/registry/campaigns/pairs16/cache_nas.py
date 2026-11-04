"""Build the NAS100 M1 npz cache (read-only DB) and print coverage for the pairs16 legs."""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
import bars
for inst in ["NAS100/USD"]:
    print(inst, bars.coverage(inst)); m = bars.load_m1(inst); print(len(m["t"]))
