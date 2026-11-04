"""fm2 zero-shot inference (#310 queue item 2). Runs inside the model's own venv under audit/fm2/.

  python infer.py MODEL INST [synthetic]

Input: out/p3_<inst>.npz from fm2.py export. For each scored P3 row i the context is the trailing CTX mid closes ending at
bar i (inclusive, the decision bar's close; nothing after it). The model forecasts H = 72 bars. Scores (per row):
  s_main  sample models: mean over sample paths of max_h |x_h - c_i| / ATR_i  (close-only paths; approximates first passage)
          quantile models: max_h max(q90_h - c_i, c_i - q10_h) / ATR_i  (marginal quantiles only: NOT a path/first-passage
          distribution; a spread proxy)
  s_p6    sample models only: fraction of sample paths with max_h |x_h - c_i| >= KX * ATR_i
  s_dir   (median_72 - c_i) / ATR_i, for the T3 sanity check
Output: out/fm_<inst>_<model>.npz (bar indices, scores, secs_per_row, meta). 'synthetic' times a random walk only.
"""
import os, sys, time, json
import numpy as np
import torch

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out")
MODEL, INST = sys.argv[1], sys.argv[2]
SYN = len(sys.argv) > 3 and sys.argv[3] == "synthetic"
TAG = INST.replace("/", "_")
CTX, H = 512, 72
BS = 64 if MODEL == "chronos_t5_small" else 256
CKPT = {"bolt_small": "amazon/chronos-bolt-small", "bolt_base": "amazon/chronos-bolt-base", "chronos_t5_small": "amazon/chronos-t5-small",
        "chronos2": "amazon/chronos-2", "timesfm25": "google/timesfm-2.5-200m-pytorch", "moirai11_small": "Salesforce/moirai-1.1-R-small"}
PREREG = os.path.join(HERE, "prereg.json")
torch.manual_seed(0); np.random.seed(0)


def load_model():
    """Returns f(ctx: (b, CTX) float32 array) -> ('samples', (b, S, H)) or ('quantiles', q10 (b,H), q50 (b,H), q90 (b,H))."""
    rid = CKPT[MODEL]
    if MODEL.startswith(("bolt", "chronos")):
        from chronos import BaseChronosPipeline
        dev = "mps" if torch.backends.mps.is_available() else "cpu"
        p = BaseChronosPipeline.from_pretrained(rid, device_map=dev, torch_dtype=torch.float32)
        if MODEL == "chronos_t5_small":
            return lambda c: ("samples", p.predict(torch.tensor(c), prediction_length=H, num_samples=20, limit_prediction_length=False).numpy())
        if MODEL == "chronos2":
            def f(c):
                q, _ = p.predict_quantiles(torch.tensor(c)[:, None, :], prediction_length=H, quantile_levels=[0.1, 0.5, 0.9])
                q = np.stack([x.squeeze(0).numpy() if x.ndim == 3 else x.numpy() for x in q])  # (b, H, 3)
                return "quantiles", q[..., 0], q[..., 1], q[..., 2]
            return f

        def f(c):
            q, _ = p.predict_quantiles(torch.tensor(c), prediction_length=H, quantile_levels=[0.1, 0.5, 0.9], limit_prediction_length=False)
            q = q.numpy()
            return "quantiles", q[..., 0], q[..., 1], q[..., 2]
        return f
    if MODEL == "timesfm25":
        import timesfm
        m = timesfm.TimesFM_2p5_200M_torch.from_pretrained(rid, torch_compile=False)
        m.compile(timesfm.ForecastConfig(max_context=CTX, max_horizon=128, normalize_inputs=True, per_core_batch_size=BS,
                                         use_continuous_quantile_head=True, force_flip_invariance=True, infer_is_positive=False,
                                         fix_quantile_crossing=True))

        def f(c):
            _, q = m.forecast(horizon=H, inputs=[x for x in c])  # q: (b, H, 10) = mean, q10..q90
            return "quantiles", q[:, :H, 1], q[:, :H, 5], q[:, :H, 9]
        return f
    if MODEL == "moirai11_small":
        from uni2ts.model.moirai import MoiraiForecast, MoiraiModule
        m = MoiraiForecast(module=MoiraiModule.from_pretrained(rid), prediction_length=H, context_length=CTX, patch_size=32,
                           num_samples=100, target_dim=1, feat_dynamic_real_dim=0, past_feat_dynamic_real_dim=0).eval()

        def f(c):
            t = torch.tensor(c, dtype=torch.float32)[..., None]
            with torch.no_grad():
                s = m(past_target=t, past_observed_target=torch.ones_like(t, dtype=torch.bool),
                      past_is_pad=torch.zeros(t.shape[:2], dtype=torch.bool))
            return "samples", s.numpy()  # (b, S, H)
        return f
    raise SystemExit(f"unknown model {MODEL}")


def score(out, c0, a, kx):
    if out[0] == "samples":
        S = out[1]
        mx = np.abs(S - c0[:, None, None]).max(2) / a[:, None]
        return dict(s_main=mx.mean(1), s_p6=(mx >= kx).mean(1), s_dir=(np.median(S[:, :, -1], 1) - c0) / a)
    _, q10, q50, q90 = out
    ex = np.maximum(q90 - c0[:, None], c0[:, None] - q10).max(1) / a
    return dict(s_main=ex, s_dir=(q50[:, -1] - c0) / a)


def main():
    if SYN:
        rng = np.random.default_rng(0); n = 20000
        mid = 70 + np.cumsum(rng.normal(0, 0.05, n)); atr = np.full(n, 0.08); rows = np.arange(CTX + 10, n, 37)[:512]; kx = 6.0
    else:
        z = np.load(os.path.join(OUT, f"p3_{TAG}.npz"))
        mid, atr, rows, kx = z["mid_c"], z["atr"], z["i"], float(z["kx"])
        utc = z["utc"]
        rule = json.load(open(PREREG))["subsample_rule_code"]  # registered before real scoring
        if rule == "hourly":
            rows = rows[utc % 60 == 0]
        rows = rows[rows >= CTX]
    f = load_model()
    res = {}; t0 = time.time()
    for a0 in range(0, len(rows), BS):
        r = rows[a0:a0 + BS]
        J = r[:, None] + np.arange(-CTX + 1, 1)[None, :]
        ctx = mid[J].astype(np.float32)
        sc = score(f(ctx), mid[r], atr[r], kx)
        for k, v in sc.items():
            res.setdefault(k, []).append(np.asarray(v, np.float64))
        if a0 // BS % 10 == 0:
            el = time.time() - t0
            print(MODEL, a0 + len(r), "/", len(rows), f"{el / (a0 + len(r)) * 1000:.1f} ms/row", flush=True)
    secs = (time.time() - t0) / len(rows)
    res = {k: np.concatenate(v) for k, v in res.items()}
    meta = json.dumps(dict(model=MODEL, checkpoint=CKPT[MODEL], ctx=CTX, h=H, kx=kx, rows=int(len(rows)), torch=torch.__version__,
                           device=str(getattr(torch.backends, "mps", None) and torch.backends.mps.is_available())))
    name = f"syn_{MODEL}" if SYN else f"fm_{TAG}_{MODEL}"
    np.savez_compressed(os.path.join(OUT, name + ".npz"), i=rows, secs_per_row=secs, meta=meta, **res)
    print("done", MODEL, len(rows), f"{secs * 1000:.2f} ms/row", {k: float(np.nanmean(v)) for k, v in res.items()})


if __name__ == "__main__":
    main()
