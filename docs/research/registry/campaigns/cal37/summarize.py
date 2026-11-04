"""Print the cal37 tables from out/results.json."""
import os, json
R = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "out", "results.json")))
f = lambda x: f"{x:+.2f}"
fc = lambda c: f"[{c[0]:+.2f},{c[1]:+.2f}]"
print("verdict", R["verdict"])
for w, cells in R["primary"].items():
    for h, c in cells.items():
        print(w, h, "n", sum(c["n_events"].values()), "days", c["n_event_days"], "| ev", f(c["event_mean_bps"]), fc(c["event_mean_ci"]),
              "| diff", f(c["diff_bps"]), fc(c["diff_ci"]), "holm", fc(c["holm_ci"]), f"lvl {c['holm_level']:.4f}",
              f"p {c['p']:.3f} holm_p {c['holm_p']:.3f}", "| gross/ev", f(c["event_gross_bps"]), "net/ev", f(c["event_net_bps"]),
              f"ev/yr {c['events_per_year']:.1f} net%/yr {c['net_annual_pct']:+.2f}", f"mde80 {c['mde80_bps']:.2f}",
              f"yrs+ {c['years_pos']}/{c['years']}")
print("yearly primary diffs (bps):")
for w, cells in R["primary"].items():
    for h, c in cells.items():
        print(" ", w, h, {k: round(v, 1) for k, v in c["yearly_diff_bps"].items()})
print("secondary per index:")
for k, c in R["secondary"].items():
    flag = "*" if c["diff_ci"][0] > 0 else ("-" if c["diff_ci"][1] < 0 else " ")
    print(f"{flag} {k:24s} n {list(c['n_events'].values())[0]:4d} ev {f(c['event_mean_bps'])} diff {f(c['diff_bps'])} {fc(c['diff_ci'])} "
          f"p {c['p']:.3f} net/ev {f(c['event_net_bps'])} net%/yr {c['net_annual_pct']:+.2f} mde80 {c['mde80_bps']:.1f} yrs+ {c['years_pos']}/{c['years']}")
print("TOM position:")
for k, c in R["secondary_tom_position"].items():
    print(" ", k, f(c["event_mean_bps"]), f(c["diff_bps"]), fc(c["diff_ci"]))
print("intraday FOMC SPX:", json.dumps(R["intraday_fomc_spx"], indent=1))
