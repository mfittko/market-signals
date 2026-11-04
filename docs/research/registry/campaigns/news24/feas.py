"""Feasibility: GDELT 2.0 file counts and compressed sizes per type and year from masterfilelist.txt."""
import sys, collections
f = sys.argv[1]
S = collections.defaultdict(lambda: [0, 0])
for line in open(f, errors="replace"):
    p = line.split()
    if len(p) != 3:
        continue
    name = p[2].rsplit("/", 1)[-1]
    y = name[:4]
    kind = name.split(".")[1] if "." in name else "?"
    if y < "2019":
        continue
    S[(kind, y)][0] += 1
    S[(kind, y)][1] += int(p[0])
tot = collections.Counter()
for (k, y), (n, b) in sorted(S.items()):
    print(f"{k:10s} {y} files={n:6d} GB={b/1e9:8.2f}")
    tot[k] += b
for k, b in tot.items():
    print("TOTAL", k, f"{b/1e9:.1f} GB")
