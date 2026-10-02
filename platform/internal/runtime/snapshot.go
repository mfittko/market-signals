package runtime

import "encoding/json"

// snap is the slice of the snapshot payload the built-in runtimes read.
type snap struct {
	Instrument string  `json:"instrument"`
	Event      string  `json:"event"`
	Close      float64 `json:"close"`
	Quote      struct {
		Last        float64 `json:"last"`
		Provisional bool    `json:"provisional"`
	} `json:"quote"`
	Trend      string  `json:"trend"`
	Supertrend float64 `json:"supertrend"`
	Flip       *struct {
		Signal  string  `json:"signal"`
		Price   float64 `json:"price"`
		BarsAgo int     `json:"barsAgo"`
		Fresh   *bool   `json:"fresh"`
	} `json:"flip"`
	Backtest *struct {
		WinRate float64 `json:"winRatePct"`
	} `json:"backtest"`
	Portfolio portfolio `json:"portfolio"`
	Strategy  struct {
		Name   string `json:"name"`
		Prompt string `json:"prompt"`
	} `json:"strategy"`
}

type portfolio struct {
	Equity    float64 `json:"equity"`
	Cash      float64 `json:"cash"`
	Halted    bool    `json:"halted"`
	Positions []struct {
		ID         int64  `json:"id"`
		Instrument string `json:"instrument"`
		Side       string `json:"side"`
	} `json:"positions"`
}

func parseSnap(raw string) (snap, error) {
	var s snap
	err := json.Unmarshal([]byte(raw), &s)
	return s, err
}

func (s snap) price() float64 {
	if s.Quote.Last > 0 {
		return s.Quote.Last
	}
	return s.Close
}
