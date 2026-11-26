package research

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"os"
	"time"

	"github.com/mfittko/market-signals/platform/internal/backtest"
)

// PullbackSpec is the frozen daily index pullback rule.
type PullbackSpec struct {
	Experiment string   `json:"experiment"`
	Symbols    []string `json:"symbols"`
	Feed       struct {
		Granularity string `json:"granularity"`
		BarTime     Note   `json:"barTime"`
		Prices      Note   `json:"prices"`
	} `json:"feed"`
	Strategy struct {
		TrendSMA   int     `json:"trendSma"`
		DownCloses int     `json:"downCloses"`
		ExitSMA    int     `json:"exitSma"`
		MaxBars    int     `json:"maxBars"`
		ATRPeriod  int     `json:"atrPeriod"`
		StopATR    float64 `json:"stopAtr"`
	} `json:"strategy"`
	Costs struct {
		SpreadBps Value `json:"spreadBps"` // round trip, subtracted from the log return
		NightBps  Value `json:"nightBps"`
		Rollover  Note  `json:"rollover"`
	} `json:"costs"`
	Timing struct {
		Entry      Note  `json:"entry"`
		ExpiryDays Value `json:"expiryDays"`
	} `json:"timing"`
	SHA256 string `json:"-"` // of the spec bytes
}

// ParsePullbackSpec decodes the spec and refuses one with an unknown field or an unlabelled value.
func ParsePullbackSpec(b []byte) (PullbackSpec, error) {
	var s PullbackSpec
	d := json.NewDecoder(bytes.NewReader(b))
	d.DisallowUnknownFields()
	if err := d.Decode(&s); err != nil {
		return s, fmt.Errorf("spec: %w", err)
	}
	if err := checkLabels([]labelled{
		{"feed.barTime", s.Feed.BarTime.Label, s.Feed.BarTime.Source},
		{"feed.prices", s.Feed.Prices.Label, s.Feed.Prices.Source},
		{"costs.spreadBps", s.Costs.SpreadBps.Label, s.Costs.SpreadBps.Source},
		{"costs.nightBps", s.Costs.NightBps.Label, s.Costs.NightBps.Source},
		{"costs.rollover", s.Costs.Rollover.Label, s.Costs.Rollover.Source},
		{"timing.entry", s.Timing.Entry.Label, s.Timing.Entry.Source},
		{"timing.expiryDays", s.Timing.ExpiryDays.Label, s.Timing.ExpiryDays.Source},
	}); err != nil {
		return s, err
	}
	st := s.Strategy
	if s.Experiment == "" || len(s.Symbols) == 0 || st.TrendSMA < 1 || st.DownCloses < 1 || st.ExitSMA < 1 ||
		st.MaxBars < 1 || st.ATRPeriod < 1 || st.StopATR <= 0 || s.Timing.ExpiryDays.Value <= 0 {
		return s, errors.New("spec: experiment and symbols must be set and every strategy setting and the expiry must be > 0")
	}
	sum := sha256.Sum256(b)
	s.SHA256 = hex.EncodeToString(sum[:])
	return s, nil
}

// sma is the mean close of the n bars that end at bar t.
func sma(c []backtest.Candle, t, n int) float64 {
	var s float64
	for _, b := range c[t-n+1 : t+1] {
		s += b.Close
	}
	return s / float64(n)
}

// setup is true when bar t closes above its trend SMA after downCloses lower closes in a row.
func (s PullbackSpec) setup(c []backtest.Candle, t int) bool {
	st := s.Strategy
	if t < st.TrendSMA-1 || t < st.DownCloses {
		return false
	}
	for k := t - st.DownCloses + 1; k <= t; k++ {
		if c[k].Close >= c[k-1].Close {
			return false
		}
	}
	return c[t].Close > sma(c, t, st.TrendSMA)
}

// trade fills the setup of bar t: long at the open of bar t+1, out at the stop, the first
// close above the exit SMA or the close of bar t+maxBars. The stop wins on a bar where both
// apply, and a bar that opens below the stop exits at its open. ok is false until the exit
// bar has completed. The outcome has no attempt id yet.
func (s PullbackSpec) trade(c []backtest.Candle, atr []float64, t int) (last int, o Outcome, ok bool) {
	st := s.Strategy
	if t+1 >= len(c) {
		return 0, o, false
	}
	entry, dist := c[t+1].Open, st.StopATR*atr[t]
	stop := entry - dist
	for k := t + 1; k < len(c) && k <= t+st.MaxBars; k++ {
		b := c[k]
		_, at := session(b.Time)
		price, kind := b.Close, ""
		switch {
		case b.Open <= stop:
			price, kind, at = b.Open, "stop", b.Time
		case b.Low <= stop:
			price, kind, at = stop, "stop", b.Time
		case b.Close > sma(c, k, st.ExitSMA):
			kind = "sma5" // the frozen exit SMA is 5
		case k == t+st.MaxBars:
			kind = "time"
		}
		if kind != "" {
			cost := (s.Costs.SpreadBps.Value + float64(rollovers(c[t+1].Time, at))*s.Costs.NightBps.Value) / 1e4
			r := (math.Log(price/entry) - cost) / (dist / entry)
			return k, Outcome{LabelVersion: LabelVersion, Matured: at, NetR: r, Label: Label(Trade{NetR: r}), Exit: kind}, true
		}
	}
	return 0, o, false
}

// evaluate replays the rule on one symbol's completed bars and returns the records the
// journal lacks. Bars that close at or before start only warm up. status maps the journal's
// attempt ids to their status, so a recorded decision always stands; done holds the
// attempt ids with an outcome.
// shortcut: a forecast older than the feed window is never resolved; fine while the loop
// runs hourly, revisit if the api stays down for weeks.
func (s PullbackSpec) evaluate(sym string, c []backtest.Candle, start, now time.Time, status map[string]string, done map[string]bool) ([]Attempt, []Outcome) {
	var attempts []Attempt
	var outcomes []Outcome
	_, atr := backtest.Supertrend(c, s.Strategy.ATRPeriod, 1) // only its Wilder ATR
	busy := -1                                                // the last bar of the open trade
	for t := range c {
		date, decision := session(c[t].Time)
		if !decision.After(start) || !s.setup(c, t) {
			continue
		}
		a := Attempt{ID: s.Experiment + "/" + sym + "/" + date, Mode: "prospective", Experiment: s.Experiment,
			SpecSHA256: s.SHA256, Decision: decision, Expiry: decision.AddDate(0, 0, int(s.Timing.ExpiryDays.Value)),
			Received: now, Status: "forecast", Dir: 1}
		st, seen := status[a.ID]
		if st == "hold" || (!seen && t <= busy) {
			a.Status, a.Dir, a.Reason = "hold", 0, "busy"
		} else {
			busy = len(c) // open until its exit bar completes
			if last, o, ok := s.trade(c, atr, t); ok {
				busy = last
				if !done[a.ID] {
					o.Attempt = a.ID
					outcomes = append(outcomes, o)
				}
			}
		}
		if !seen {
			attempts = append(attempts, a)
		}
	}
	return attempts, outcomes
}

// Pullback journals the rule prospectively. The journal is its only state, so a restart
// repeats no attempt and no outcome.
type Pullback struct {
	Spec    PullbackSpec
	Feed    DailyFeed
	Journal string    // path
	Start   time.Time // go-live; bars that close at or before it write nothing
	Log     *slog.Logger
}

// Tick reads the journal, fetches every symbol and appends the new attempts and outcomes.
func (p *Pullback) Tick(ctx context.Context, now time.Time) error {
	b, err := os.ReadFile(p.Journal)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	j, err := ReadJournal(bytes.NewReader(b))
	if err != nil {
		return err
	}
	status, done := map[string]string{}, map[string]bool{}
	for _, a := range j.Attempts {
		status[a.ID] = a.Status
	}
	for _, o := range j.Outcomes {
		done[o.Attempt] = true
	}
	var attempts []Attempt
	var outcomes []Outcome
	var errs []error
	for _, sym := range p.Spec.Symbols {
		raw, err := p.Feed.Daily(ctx, sym)
		if err != nil {
			errs = append(errs, fmt.Errorf("pullback %s: %w", sym, err))
			continue
		}
		a, o := p.Spec.evaluate(sym, completedDays(raw), p.Start, now, status, done)
		attempts, outcomes = append(attempts, a...), append(outcomes, o...)
	}
	if len(attempts)+len(outcomes) > 0 {
		errs = append(errs, Append(p.Journal, attempts, outcomes))
	}
	return errors.Join(errs...)
}

// Run ticks at once and then every interval until ctx ends.
func (p *Pullback) Run(ctx context.Context, every time.Duration) {
	for {
		if err := p.Tick(ctx, time.Now().UTC()); err != nil {
			p.Log.Error("pullback journal", "err", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(every):
		}
	}
}
