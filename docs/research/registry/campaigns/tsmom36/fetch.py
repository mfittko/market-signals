"""tsmom36 data: OANDA DAILY mid candles via the FXEmpire proxy (same URL and headers as pipeline/history.py)
-> audit/tsmom36/daily.db (new file; history.db and candles.db are never touched).

Daily bars close at 17:00 America/New_York (dailyAlignment=17, the OANDA/FX convention), so every instrument shares
one daily clock. Pages forward from 2000-01-01, 5000 bars per request, >= 3 s between requests (limit is 1 req/s).

usage: python fetch.py [INSTRUMENT ...]
"""
import json, os, sqlite3, sys, time, urllib.error, urllib.parse, urllib.request
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
DB = os.path.join(HERE, 'daily.db')
URL = 'https://p.fxempire.com/oanda/candles/latest'
COUNT = 5000
PAUSE = 3.0
UNIVERSE = {
    'fx': ['EUR_USD', 'GBP_USD', 'USD_JPY', 'AUD_USD', 'USD_CAD', 'USD_CHF', 'NZD_USD', 'EUR_JPY', 'EUR_GBP', 'AUD_JPY'],
    'index': ['SPX500_USD', 'NAS100_USD', 'US30_USD', 'DE30_EUR', 'UK100_GBP', 'JP225_USD', 'AU200_AUD', 'HK33_HKD'],
    'commodity': ['WTICO_USD', 'BCO_USD', 'NATGAS_USD', 'XAU_USD', 'XAG_USD', 'XCU_USD', 'XPT_USD', 'CORN_USD',
                  'WHEAT_USD', 'SOYBN_USD', 'SUGAR_USD'],
    'bond': ['USB10Y_USD', 'USB30Y_USD', 'DE10YB_EUR', 'UK10YB_GBP'],
}
_last = [0.0]


def get(inst, frm):
    """One request. Returns candles, or None when the proxy does not serve the instrument (4xx / empty)."""
    q = urllib.parse.urlencode({'instrument': inst.replace('_', '/'), 'granularity': 'D', 'count': COUNT, 'price': 'M',
                                'from': frm.strftime('%Y-%m-%dT%H:%M:%SZ'), 'dailyAlignment': 17,
                                'alignmentTimezone': 'America/New_York'})
    req = urllib.request.Request(f'{URL}?{q}', headers={
        'accept': 'application/json', 'user-agent': 'Mozilla/5.0 (market-signals; history)'})
    for attempt in range(6):
        time.sleep(max(0.0, _last[0] + PAUSE - time.time()))
        _last[0] = time.time()
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.load(r).get('candles') or []
        except urllib.error.HTTPError as e:
            if 400 <= e.code < 500 and e.code != 429:
                print(f'{inst} HTTP {e.code}', flush=True)
                return None
            wait = 60 * 2 ** attempt
        except (urllib.error.URLError, TimeoutError, ValueError, OSError) as e:
            wait = 60 * 2 ** attempt
        print(f'{inst} {frm:%Y-%m-%d} error, retry in {wait}s', flush=True)
        time.sleep(wait)
    raise RuntimeError(f'{inst}: giving up')


def main():
    db = sqlite3.connect(DB)
    db.execute('CREATE TABLE IF NOT EXISTS daily (instrument TEXT, cls TEXT, time TEXT, o REAL, h REAL, l REAL, c REAL, '
               'volume REAL, PRIMARY KEY (instrument, time))')
    db.execute('CREATE TABLE IF NOT EXISTS fetch_log (instrument TEXT PRIMARY KEY, cls TEXT, status TEXT, rows INTEGER, '
               'first TEXT, last TEXT, fetched_at TEXT)')
    want = set(sys.argv[1:])
    for cls, insts in UNIVERSE.items():
        for inst in insts:
            if want and inst not in want:
                continue
            frm, n, status = datetime(2000, 1, 1, tzinfo=timezone.utc), 0, 'ok'
            while True:
                rows = get(inst, frm)
                if rows is None:
                    status = 'not served'
                    break
                done = [r for r in rows if r.get('complete')]
                db.executemany('INSERT OR REPLACE INTO daily VALUES (?,?,?,?,?,?,?,?)', [
                    (inst, cls, r['time'][:19], *(float(r['mid'][k]) for k in 'ohlc'), float(r.get('volume', 0)))
                    for r in done])
                db.commit()
                n += len(done)
                if len(rows) < COUNT or not done:
                    break
                frm = datetime.strptime(done[-1]['time'][:19], '%Y-%m-%dT%H:%M:%S').replace(tzinfo=timezone.utc) + timedelta(hours=1)
            if n == 0 and status == 'ok':
                status = 'empty'
            first, last = db.execute('SELECT min(time), max(time) FROM daily WHERE instrument=?', (inst,)).fetchone()
            db.execute('INSERT OR REPLACE INTO fetch_log VALUES (?,?,?,?,?,?,?)',
                       (inst, cls, status, n, first, last, datetime.now(timezone.utc).isoformat(timespec='seconds')))
            db.commit()
            print(f'{inst} {status} rows={n} {first} .. {last}', flush=True)


if __name__ == '__main__':
    main()
