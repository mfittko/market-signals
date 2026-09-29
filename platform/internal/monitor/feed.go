package monitor

import (
	"context"
	"net/url"
	"time"

	"github.com/mfittko/market-signals/platform/internal/tools"
)

// EngineFeed reads the running engine. Every call is a read-only GET.
type EngineFeed struct{ Eng *tools.Engine }

type chartResp struct {
	Candles []struct {
		Time     string  `json:"time"`
		Open     float64 `json:"open"`
		High     float64 `json:"high"`
		Low      float64 `json:"low"`
		Close    float64 `json:"close"`
		Volume   float64 `json:"volume"`
		Complete *bool   `json:"complete"`
	} `json:"candles"`
	Signals []struct {
		Time   string `json:"time"`
		Kind   string `json:"kind"`
		Signal string `json:"signal"`
	} `json:"signals"`
	// the series is computed on completed candles only; the quote value includes the forming one
	Supertrend []struct {
		Time  string  `json:"time"`
		Value float64 `json:"value"`
	} `json:"supertrend"`
	Quote struct {
		Last       float64 `json:"last"`
		Supertrend struct {
			Value float64 `json:"value"`
		} `json:"supertrend"`
	} `json:"quote"`
}

func parseTime(s string) time.Time {
	t, _ := time.Parse(time.RFC3339Nano, s)
	return t
}

// Market fetches M1 bars for fills and the position timeframe for flips, impulses and ATR.
// Forming bars are dropped, so a rule never fires on a candle that can still change.
func (f EngineFeed) Market(ctx context.Context, instrument, granularity string) (Market, error) {
	var m Market
	var m1 chartResp
	if err := f.Eng.Get(ctx, "/api/chart", url.Values{"instrument": {instrument}, "granularity": {"M1"}}, &m1); err != nil {
		return m, err
	}
	for _, c := range m1.Candles {
		if c.Complete != nil && !*c.Complete {
			continue
		}
		m.Bars = append(m.Bars, Bar{Time: parseTime(c.Time), Open: c.Open, High: c.High, Low: c.Low, Close: c.Close, Volume: c.Volume})
	}
	SortBars(m.Bars)
	m.Price = m1.Quote.Last
	m.AsOf = time.Now()

	// the position's own timeframe carries the flips the agent traded on
	tf := m1
	if granularity != "M1" {
		tf = chartResp{}
		if err := f.Eng.Get(ctx, "/api/chart", url.Values{"instrument": {instrument}, "granularity": {granularity}}, &tf); err != nil {
			return m, err
		}
	}
	m.Supertrend = completedSupertrend(tf)
	for _, s := range tf.Signals {
		e := Event{Time: parseTime(s.Time)}
		switch s.Kind {
		case "supertrend-flip":
			e.Dir = 1
			if s.Signal == "sell" {
				e.Dir = -1
			}
			m.Flips = append(m.Flips, e)
		case "volume-impulse":
			m.Impulses = append(m.Impulses, e)
		}
	}
	var ind struct {
		Indicators map[string]any `json:"indicators"`
	}
	if err := f.Eng.Get(ctx, "/api/indicators", url.Values{"instrument": {instrument}, "granularity": {granularity}}, &ind); err == nil {
		m.ATR, _ = ind.Indicators["atr14"].(float64)
	}
	var pf struct {
		Portfolio struct {
			Halted bool `json:"halted"`
		} `json:"portfolio"`
	}
	if err := f.Eng.Get(ctx, "/api/portfolio", nil, &pf); err == nil {
		m.Halted = pf.Portfolio.Halted
	}
	return m, nil
}

// completedSupertrend returns the line as of the newest completed candle. The quote's value moves with
// the forming candle, and a trailing stop must not follow a bar that can still retrace.
func completedSupertrend(tf chartResp) float64 {
	done := ""
	for _, c := range tf.Candles {
		if c.Complete == nil || *c.Complete {
			done = c.Time
		}
	}
	for i := len(tf.Supertrend) - 1; i >= 0; i-- {
		if tf.Supertrend[i].Time <= done {
			return tf.Supertrend[i].Value
		}
	}
	return 0 // unknown: the trail rule then does nothing
}
