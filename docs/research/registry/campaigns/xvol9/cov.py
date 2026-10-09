"""Coverage check (read-only): M1 rows per instrument and year in candles_ba."""
import sqlite3
DB = "file:/Users/mfittko/github/market-signals/data/research/history.db?mode=ro"
con = sqlite3.connect(DB, uri=True, timeout=5)
for inst, n, a, b in con.execute("select instrument, count(*), min(time), max(time) from candles_ba where granularity='M1' "
                                 "group by instrument order by instrument"):
    print(inst, n, a[:16], b[:16])
    yrs = con.execute("select substr(time,1,4), count(*) from candles_ba where granularity='M1' and instrument=? group by 1",
                      (inst,)).fetchall()
    print("   ", " ".join(f"{y}:{c // 1000}k" for y, c in yrs))
