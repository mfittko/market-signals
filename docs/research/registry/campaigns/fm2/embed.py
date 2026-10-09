"""fm2 retrieval add-on (queue item 3 folded in): Chronos-Bolt-small encoder embeddings of the same 512-bar trailing
contexts (mean over encoder tokens; the pipeline standardizes each context by its own mean/std), then a kNN T2 score
over MATURED past rows only.

  python embed.py INST         (chronos venv)  -> out/emb_<inst>_bolt_small.npz
  python embed.py INST knn     (any venv with numpy)  -> out/fm_<inst>_knn_bolt.npz

kNN (registered in the prereg amendment before scoring): cosine distance on L2-normalized embeddings; for a row in
calendar year Y the library is every P3 hourly row whose label ended before Jan 1 of Y - 6 months - 5 days (= that
fold's V4 fit set; rows before 2020 get no score). K = 50. s_main = share of T2 among the K neighbours; s_dist = mean
cosine distance to them; abstention = s_dist above the 80th percentile of the library's own leave-one-out K-distance.
"""
import os, sys, time, json
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out")
INST = sys.argv[1]; TAG = INST.replace("/", "_")
CTX, K = 512, 50
z = np.load(os.path.join(OUT, f"p3_{TAG}.npz"))
f = np.load(os.path.join(OUT, f"fm_{TAG}_bolt_small.npz"))  # same row set as the registered inference
rows = f["i"]


def embed():
    import torch
    from chronos import BaseChronosPipeline
    p = BaseChronosPipeline.from_pretrained("amazon/chronos-bolt-small", device_map="mps", torch_dtype=torch.float32)
    mid = z["mid_c"]; E = []; t0 = time.time()
    for a in range(0, len(rows), 256):
        r = rows[a:a + 256]
        ctx = torch.tensor(mid[r[:, None] + np.arange(-CTX + 1, 1)[None, :]], dtype=torch.float32)
        e, _ = p.embed(ctx)
        E.append(e.mean(1).numpy().astype(np.float32))
    E = np.concatenate(E)
    np.savez_compressed(os.path.join(OUT, f"emb_{TAG}_bolt_small.npz"), i=rows, E=E, secs_per_row=(time.time() - t0) / len(rows))
    print("embedded", E.shape, (time.time() - t0) / len(rows) * 1000, "ms/row")


def knn():
    e = np.load(os.path.join(OUT, f"emb_{TAG}_bolt_small.npz"))
    E = e["E"] / np.linalg.norm(e["E"], axis=1, keepdims=True)
    pos = {b: k for k, b in enumerate(z["i"])}
    k = np.array([pos[b] for b in rows])
    day, y2 = z["day"][k], z["y2"][k]
    t = z["t"][rows].astype("datetime64[m]")
    yr = t.astype("datetime64[Y]").astype(int) + 1970
    end_day = day + 1 + 72 * 5 // 1440 + 3  # label end <= 72 bars later (+ weekend); conservative by 3 days
    s, sd, ab = (np.full(len(rows), np.nan) for _ in range(3))
    t0 = time.time()
    for Y in range(2020, int(yr.max()) + 1):
        lo = int((np.datetime64(f"{min(Y, 2023)}-01", "M") - np.timedelta64(6, "M")).astype("datetime64[D]").astype(int)) - 5  # fold start - 6 months - 5 days
        lib = np.where(np.isfinite(y2) & (end_day < lo))[0]
        assert len(lib) > 200 and day[lib].max() < lo, (Y, len(lib))  # matured past rows only
        q = np.where(yr == Y)[0]
        D = 1 - E[q] @ E[lib].T
        nn = np.argpartition(D, K, axis=1)[:, :K]
        s[q] = y2[lib][nn].mean(1); sd[q] = np.take_along_axis(D, nn, 1).mean(1)
        Dl = 1 - E[lib] @ E[lib].T; np.fill_diagonal(Dl, np.inf)
        thr = np.quantile(np.sort(np.partition(Dl, K, axis=1)[:, :K], 1).mean(1), 0.8)
        ab[q] = sd[q] > thr
        print(Y, "library", len(lib), "queries", len(q), "abstain", float(ab[q].mean()))
    np.savez_compressed(os.path.join(OUT, f"fm_{TAG}_knn_bolt.npz"), i=rows, s_main=s, s_dist=-sd, s_abstain=ab,
                        secs_per_row=float(e["secs_per_row"]) + (time.time() - t0) / len(rows),
                        meta=json.dumps(dict(model="knn_bolt", K=K, embed="chronos-bolt-small mean encoder tokens")))


if __name__ == "__main__":
    knn() if len(sys.argv) > 2 and sys.argv[2] == "knn" else embed()
