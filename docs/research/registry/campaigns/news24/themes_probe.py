"""List GKG theme names matching keywords in one sample file (to write the relevance config; no outcomes)."""
import sys, zipfile, io, collections, re
z = zipfile.ZipFile(sys.argv[1])
raw = z.read(z.namelist()[0]).decode("utf-8", "replace")
C = collections.Counter(); n = 0
for line in raw.split("\n"):
    f = line.split("\t")
    if len(f) < 10:
        continue
    n += 1
    for th in set(f[7].split(";")):
        if th:
            C[th] += 1
print("rows", n, "fields", len(f))
pat = re.compile(sys.argv[2], re.I)
for th, c in C.most_common():
    if pat.search(th):
        print(c, th)
