package research

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"time"

	"github.com/mfittko/market-signals/platform/internal/backtest"
)

// DailyCandle is one daily mid bar as the feed returns it; Complete is false on the
// forming bar.
type DailyCandle struct {
	backtest.Candle
	Complete bool
}

// DailyFeed returns the latest daily mid bars of a symbol, oldest first.
type DailyFeed interface {
	Daily(ctx context.Context, symbol string) ([]DailyCandle, error)
}

// FXEmpire reads daily mid bars from the FXEmpire OANDA proxy, which needs no credential.
// shortcut: the bars live in memory per request; read them from the Go D store
// (https://github.com/mfittko/market-signals/issues/351) once it exists.
type FXEmpire struct {
	Client *http.Client
	last   time.Time
}

// fxempirePause keeps at least this much time between two requests.
const fxempirePause = 3 * time.Second

func (f *FXEmpire) Daily(ctx context.Context, symbol string) ([]DailyCandle, error) {
	if wait := time.Until(f.last.Add(fxempirePause)); wait > 0 {
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(wait):
		}
	}
	defer func() { f.last = time.Now() }()
	q := url.Values{"instrument": {symbol}, "granularity": {"D"}, "count": {"250"}, "price": {"M"},
		"dailyAlignment": {"17"}, "alignmentTimezone": {"America/New_York"}}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://p.fxempire.com/oanda/candles/latest?"+q.Encode(), nil)
	if err != nil {
		return nil, err
	}
	// the same headers scripts/supertrend.mjs sends
	req.Header.Set("accept", "application/json,*/*")
	req.Header.Set("user-agent", "Mozilla/5.0 (market-signals; supertrend)")
	res, err := f.Client.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("daily %s: HTTP %d", symbol, res.StatusCode)
	}
	return parseCandles(res.Body)
}

// parseCandles reads an OANDA candles payload; prices may come as strings or numbers.
func parseCandles(r io.Reader) ([]DailyCandle, error) {
	var p struct {
		Candles []struct {
			Time     time.Time                        `json:"time"`
			Complete bool                             `json:"complete"`
			Mid      struct{ O, H, L, C json.Number } `json:"mid"`
		} `json:"candles"`
	}
	if err := json.NewDecoder(r).Decode(&p); err != nil {
		return nil, fmt.Errorf("daily candles: %w", err)
	}
	out := make([]DailyCandle, 0, len(p.Candles))
	for _, c := range p.Candles {
		var f [4]float64
		for k, n := range []json.Number{c.Mid.O, c.Mid.H, c.Mid.L, c.Mid.C} {
			var err error
			if f[k], err = n.Float64(); err != nil {
				return nil, fmt.Errorf("daily candle %s: %w", c.Time, err)
			}
			// a price at or below zero makes the net R of a trade NaN or infinite
			if f[k] <= 0 {
				return nil, fmt.Errorf("daily candle %s: price %v is not > 0", c.Time, f[k])
			}
		}
		out = append(out, DailyCandle{backtest.Candle{Time: c.Time, Open: f[0], High: f[1], Low: f[2], Close: f[3]}, c.Complete})
	}
	return out, nil
}

// session gives the trading date and close time of a daily bar that opens at 17:00 New
// York: the trading date is the open date plus one day, and the bar closes at 17:00 then.
func session(open time.Time) (string, time.Time) {
	o := open.In(newYork)
	c := time.Date(o.Year(), o.Month(), o.Day()+1, 17, 0, 0, 0, newYork)
	return c.Format(time.DateOnly), c
}

// completedDays drops the forming bar and the weekend stubs, as ext39.load does.
func completedDays(raw []DailyCandle) []backtest.Candle {
	var out []backtest.Candle
	for _, c := range raw {
		if _, cl := session(c.Time); c.Complete && cl.Weekday() != time.Saturday && cl.Weekday() != time.Sunday {
			out = append(out, c.Candle)
		}
	}
	return out
}
