import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
import de_v2 as de
m1, B, O, L = de.prep(sys.argv[1], None)
print("warm", sys.argv[1], len(B["t"]))
