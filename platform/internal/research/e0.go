// Package research runs frozen research experiments on an exported bid and ask candle
// file. Exits go through fill.Check and entries through the ledger's entry rule, so the
// experiment uses the same execution and accounting rules as the Go ledger. A run reads
// only the spec and the data file; it opens no database and no network connection.
package research

import (
	"bytes"
	"crypto/sha256"
	"encoding/csv"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"slices"
	"strconv"
	"time"
	_ "time/tzdata" // the financing rollover needs America/New_York on any host

	"github.com/mfittko/market-signals/platform/internal/backtest"
	"github.com/mfittko/market-signals/platform/internal/fill"
	"github.com/mfittko/market-signals/platform/internal/ledger"
)

// Value is one declared number with its provenance.
type Value struct {
	Value  float64 `json:"value"`
	Label  string  `json:"label"` // assumed | measured
	Source string  `json:"source"`
}

// Note is a declared rule without a number, with its provenance.
type Note struct {
	Rule   string `json:"rule"`
	Label  string `json:"label"`
	Source string `json:"source"`
}

type Spec struct {
	Instrument struct {
		Name          string `json:"name"`
		QuoteCurrency string `json:"quoteCurrency"`
	} `json:"instrument"`
	Feed struct {
		Granularity string `json:"granularity"`
		BarSeconds  int    `json:"barSeconds"`
		BarTime     Note   `json:"barTime"`
		Prices      Note   `json:"prices"`
	} `json:"feed"`
	Dataset struct {
		Path   string    `json:"path"`
		SHA256 string    `json:"sha256"`
		Rows   int       `json:"rows"`
		First  time.Time `json:"first"`
		Last   time.Time `json:"last"`
	} `json:"dataset"`
	Experiment struct {
		ID       string `json:"id"`
		Strategy struct {
			SupertrendPeriod int     `json:"supertrendPeriod"`
			SupertrendMult   float64 `json:"supertrendMult"`
			StopATR          float64 `json:"stopAtr"`
			RR               float64 `json:"rr"`
			MaxBars          int     `json:"maxBars"`
		} `json:"strategy"`
		Costs struct {
			Spread            Note  `json:"spread"`
			Commission        Value `json:"commission"`
			FinancingBasis    Value `json:"financingBasis"`  // annual rate
			FinancingMarkup   Value `json:"financingMarkup"` // annual rate
			FinancingRollover Note  `json:"financingRollover"`
		} `json:"costs"`
		Timing struct {
			DecisionDelayMs Value `json:"decisionDelayMs"`
		} `json:"timing"`
	} `json:"experiment"`
}

type labelled struct{ name, label, source string }

// checkLabels refuses a declared value that is not labelled assumed or measured with a source.
func checkLabels(vs []labelled) error {
	for _, v := range vs {
		if (v.label != "assumed" && v.label != "measured") || v.source == "" {
			return fmt.Errorf("spec: %s must be labelled assumed or measured, with a source", v.name)
		}
	}
	return nil
}

// ParseSpec decodes a spec and refuses one with an unknown field or an unlabelled value.
func ParseSpec(b []byte) (Spec, error) {
	var s Spec
	d := json.NewDecoder(bytes.NewReader(b))
	d.DisallowUnknownFields()
	if err := d.Decode(&s); err != nil {
		return s, fmt.Errorf("spec: %w", err)
	}
	e := s.Experiment
	if err := checkLabels([]labelled{
		{"feed.barTime", s.Feed.BarTime.Label, s.Feed.BarTime.Source},
		{"feed.prices", s.Feed.Prices.Label, s.Feed.Prices.Source},
		{"costs.spread", e.Costs.Spread.Label, e.Costs.Spread.Source},
		{"costs.commission", e.Costs.Commission.Label, e.Costs.Commission.Source},
		{"costs.financingBasis", e.Costs.FinancingBasis.Label, e.Costs.FinancingBasis.Source},
		{"costs.financingMarkup", e.Costs.FinancingMarkup.Label, e.Costs.FinancingMarkup.Source},
		{"costs.financingRollover", e.Costs.FinancingRollover.Label, e.Costs.FinancingRollover.Source},
		{"timing.decisionDelayMs", e.Timing.DecisionDelayMs.Label, e.Timing.DecisionDelayMs.Source},
	}); err != nil {
		return s, err
	}
	st := e.Strategy
	switch {
	case s.Feed.BarSeconds <= 0, st.SupertrendPeriod < 1, st.SupertrendMult <= 0, st.StopATR <= 0, st.RR < 0, st.MaxBars < 1:
		return s, errors.New("spec: bar seconds must be > 0, rr must be >= 0 and the other strategy settings > 0")
	case e.Costs.Commission.Value != 0:
		// shortcut: the runner reports R per unit and has no notional, so it cannot charge a commission; add sizing when a spec needs one
		return s, errors.New("spec: commission must be 0")
	case e.Timing.DecisionDelayMs.Value < 0:
		return s, errors.New("spec: decision delay must be >= 0")
	}
	return s, nil
}

var header = []string{"instrument", "granularity", "time", "bid_o", "bid_h", "bid_l", "bid_c", "ask_o", "ask_h", "ask_l", "ask_c", "volume"}

// Load reads the export and refuses it unless its sha256, instrument and granularity
// match the spec and its times ascend. Bid and ask come back as two candle series on
// the same times.
func Load(s Spec, r io.Reader) (bid, ask []backtest.Candle, err error) {
	h := sha256.New()
	cr := csv.NewReader(io.TeeReader(r, h))
	cr.ReuseRecord = true
	rec, err := cr.Read()
	if err != nil {
		return nil, nil, fmt.Errorf("data: %w; re-export the file", err)
	}
	if !slices.Equal(rec, header) {
		return nil, nil, fmt.Errorf("data: header %v, want %v; re-export the file", rec, header)
	}
	for line := 2; ; line++ {
		rec, err = cr.Read()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, nil, fmt.Errorf("data line %d: %w; re-export the file", line, err)
		}
		if rec[0] != s.Instrument.Name || rec[1] != s.Feed.Granularity {
			return nil, nil, fmt.Errorf("data line %d: %s %s is not the spec's instrument and granularity; re-export the file", line, rec[0], rec[1])
		}
		t, err := time.Parse(time.RFC3339Nano, rec[2])
		if err != nil {
			return nil, nil, fmt.Errorf("data line %d: %w; re-export the file", line, err)
		}
		var f [9]float64
		for k := range f {
			if f[k], err = strconv.ParseFloat(rec[3+k], 64); err != nil {
				return nil, nil, fmt.Errorf("data line %d: %w; re-export the file", line, err)
			}
		}
		if n := len(bid); n > 0 && !t.After(bid[n-1].Time) {
			return nil, nil, fmt.Errorf("data line %d: time %s is not after the previous row; re-export the file", line, rec[2])
		}
		bid = append(bid, backtest.Candle{Time: t, Open: f[0], High: f[1], Low: f[2], Close: f[3], Volume: f[8]})
		ask = append(ask, backtest.Candle{Time: t, Open: f[4], High: f[5], Low: f[6], Close: f[7], Volume: f[8]})
	}
	// the hash covers the rows and their times, so the other manifest fields are descriptive
	if got := hex.EncodeToString(h.Sum(nil)); got != s.Dataset.SHA256 {
		return nil, nil, fmt.Errorf("data: sha256 %s, manifest %s; re-export the file or change the manifest in a reviewed commit", got, s.Dataset.SHA256)
	}
	return bid, ask, nil
}

type Trade struct {
	Flip        time.Time `json:"flip"`     // open time of the flip bar
	Decision    time.Time `json:"decision"` // flip bar close plus the decision delay
	Entry       time.Time `json:"entry"`
	Exit        time.Time `json:"exit"`
	Dir         int       `json:"dir"`
	EntryPrice  float64   `json:"entryPrice"`
	ExitPrice   float64   `json:"exitPrice"`
	Reason      string    `json:"reason"`       // stop | target | reversal | time | end
	R           float64   `json:"r"`            // after spread, before financing
	EntrySpread float64   `json:"entrySpreadR"` // ask minus bid at the entry open, in R
	// SpreadR is half the entry-open spread plus half the exit bar's spread, in R: the
	// exit half is taken at the exit bar's close for time and end exits, else at its open
	SpreadR float64 `json:"spreadR"`
	// GrossR is R plus SpreadR: the spread cost added back on the same exits. It is no
	// mid-price replay, because the spread chose those exits.
	GrossR     float64 `json:"grossR"`
	Rollovers  int     `json:"rollovers"`
	FinancingR float64 `json:"financingR"` // a cost when positive, a credit when negative
	NetR       float64 `json:"netR"`       // GrossR minus SpreadR minus FinancingR
}

// Summary totals are in R; GrossR minus SpreadR minus FinancingR is Net.TotalR.
type Summary struct {
	Net             backtest.Stats `json:"net"`
	GrossR          float64        `json:"grossR"`
	SpreadR         float64        `json:"spreadR"`
	FinancingR      float64        `json:"financingR"`
	MeanEntrySpread float64        `json:"meanEntrySpreadR"`
}

type Artifact struct {
	Experiment string  `json:"experiment"`
	SpecSHA256 string  `json:"specSha256"`
	DataSHA256 string  `json:"dataSha256"`
	Flips      int     `json:"flips"`
	Trades     []Trade `json:"trades"`
	Summary    Summary `json:"summary"`
	// Holds stays out of the JSON, so the published artifact sha256 does not change.
	Holds []Hold `json:"-"`
}

// Hold is a flip that became no trade.
type Hold struct {
	Flip     time.Time
	Decision time.Time
	Reason   string // busy | no_atr | no_entry_bar
}

var newYork = mustLoad("America/New_York")

func mustLoad(name string) *time.Location {
	l, err := time.LoadLocation(name)
	if err != nil {
		panic(err)
	}
	return l
}

// rollovers counts the 17:00 New York instants in (a, b].
func rollovers(a, b time.Time) int {
	l := a.In(newYork)
	r := time.Date(l.Year(), l.Month(), l.Day(), 17, 0, 0, 0, newYork)
	if !r.After(a) {
		r = r.AddDate(0, 0, 1)
	}
	n := 0
	for ; !r.After(b); r = r.AddDate(0, 0, 1) {
		n++
	}
	return n
}

// actAt is the first bar that opens at or after decision, or len(bid) when none does.
func actAt(bid []backtest.Candle, from int, decision time.Time) int {
	for from < len(bid) && bid[from].Time.Before(decision) {
		from++
	}
	return from
}

// entryPrice is the ledger entry rule at the open of bar j: a long buys at the ask, a
// short sells at the bid.
func entryPrice(bid, ask []backtest.Candle, j, dir int) float64 {
	side := "short"
	if dir > 0 {
		side = "long"
	}
	mid := (bid[j].Open + ask[j].Open) / 2
	half := (ask[j].Open - bid[j].Open) / 2
	return ledger.EntryPrice(side, mid, half)
}

// plan is one decided entry: the signal bar i, the entry bar j, the side and the stop
// distance in price units.
type plan struct {
	i, j, dir int
	dist      float64
	decision  time.Time
}

// simulate fills one planned entry under the spec's target, time stop, spread and
// financing. A long enters at the ask open and its stop and target are judged on bid
// bars; a short enters at the bid open and is judged on ask bars. flipDir maps a bar to
// the direction of its flip for the reversal exit; a nil flipDir turns the reversal exit
// off. It returns the trade and its exit bar.
func simulate(s Spec, bid, ask []backtest.Candle, flipDir map[int]int, p plan) (Trade, int) {
	e := s.Experiment
	st := e.Strategy
	bar := time.Duration(s.Feed.BarSeconds) * time.Second
	delay := time.Duration(e.Timing.DecisionDelayMs.Value * float64(time.Millisecond))
	i, j, dist := p.i, p.j, p.dist
	long := p.dir > 0
	entry := entryPrice(bid, ask, j, p.dir)
	d := float64(p.dir)
	stop := entry - d*dist
	var target *float64
	if st.RR > 0 {
		t := entry + d*st.RR*dist
		target = &t
	}
	exitSide := bid // a long sells at the bid, a short buys at the ask
	if !long {
		exitSide = ask
	}
	tr := Trade{Flip: bid[i].Time, Decision: p.decision, Entry: bid[j].Time, Dir: p.dir, EntryPrice: entry, Reason: "end"}
	last := len(bid) - 1
	tr.ExitPrice, tr.Exit = exitSide[last].Close, bid[last].Time.Add(bar)
	// pending is the bar whose open fills an opposite flip; the position stays open, and
	// stop, target and time stop still apply, on every bar before it. An opposite flip
	// between the flip bar and the entry bar counts too; its fill is never before j.
	pending := -1
	for k := i + 1; k < j; k++ {
		if flipDir[k] == -p.dir {
			pending = actAt(bid, k+1, bid[k].Time.Add(bar+delay))
			break
		}
	}
	for k := j; k < len(bid) && k < j+st.MaxBars; k++ {
		b := exitSide[k]
		if k == pending {
			tr.ExitPrice, tr.Reason, tr.Exit, last = b.Open, "reversal", bid[k].Time, k
			break
		}
		if price, reason := fill.Check(long, stop, target, b.Open, b.High, b.Low); reason != "" {
			tr.ExitPrice, tr.Reason, tr.Exit, last = price, reason, b.Time, k
			break
		}
		if pending < 0 && flipDir[k] == -p.dir {
			pending = actAt(bid, k+1, bid[k].Time.Add(bar+delay))
		}
		if k == j+st.MaxBars-1 {
			tr.ExitPrice, tr.Reason, tr.Exit, last = b.Close, "time", b.Time.Add(bar), k
		}
	}
	tr.R = d * (tr.ExitPrice - entry) / dist
	tr.EntrySpread = (ask[j].Open - bid[j].Open) / dist
	exitSpread := ask[last].Open - bid[last].Open
	if tr.Reason == "time" || tr.Reason == "end" {
		exitSpread = ask[last].Close - bid[last].Close
	}
	tr.SpreadR = tr.EntrySpread/2 + exitSpread/2/dist
	tr.GrossR = tr.R + tr.SpreadR
	tr.Rollovers = rollovers(tr.Entry, tr.Exit)
	rate := e.Costs.FinancingBasis.Value + e.Costs.FinancingMarkup.Value // a long pays basis plus markup
	if !long {
		rate = e.Costs.FinancingMarkup.Value - e.Costs.FinancingBasis.Value // a short receives basis minus markup
	}
	tr.FinancingR = float64(tr.Rollovers) * entry * rate / 365 / dist
	tr.NetR = tr.R - tr.FinancingR
	return tr, last
}

// Run replays the spec's strategy. Signals come from bid bars. A decision exists at its
// bar's close plus the decision delay, and it acts at the open of the first bar at or
// after that time. Fills, exits and costs follow simulate, with the reversal exit on.
func Run(s Spec, bid, ask []backtest.Candle) Artifact {
	e := s.Experiment
	st := e.Strategy
	bar := time.Duration(s.Feed.BarSeconds) * time.Second
	delay := time.Duration(e.Timing.DecisionDelayMs.Value * float64(time.Millisecond))
	flips, atr := backtest.Supertrend(bid, st.SupertrendPeriod, st.SupertrendMult)
	idx := make(map[int64]int, len(bid))
	for i, c := range bid {
		idx[c.Time.UnixNano()] = i
	}
	flipDir := make(map[int]int, len(flips))
	for _, f := range flips {
		flipDir[idx[f.Time.UnixNano()]] = f.Dir
	}
	art := Artifact{Experiment: e.ID, Flips: len(flips)}
	busy := -1
	for _, f := range flips {
		i := idx[f.Time.UnixNano()]
		decision := bid[i].Time.Add(bar + delay)
		hold, j := "", 0
		switch {
		case i <= busy:
			hold = "busy"
		case atr[i] <= 0:
			hold = "no_atr"
		default:
			// no bar is left to act on; every later flip that is not busy holds the same way
			if j = actAt(bid, i+1, decision); j >= len(bid) {
				hold = "no_entry_bar"
			}
		}
		if hold != "" {
			art.Holds = append(art.Holds, Hold{Flip: f.Time, Decision: decision, Reason: hold})
			continue
		}
		tr, last := simulate(s, bid, ask, flipDir, plan{i: i, j: j, dir: f.Dir, dist: st.StopATR * atr[i], decision: decision})
		busy = last
		art.Trades = append(art.Trades, tr)
	}
	net := make([]backtest.Trade, len(art.Trades))
	for k, t := range art.Trades {
		net[k] = backtest.Trade{Entry: t.Entry, Dir: t.Dir, R: t.NetR, Reason: t.Reason}
		art.Summary.GrossR += t.GrossR
		art.Summary.SpreadR += t.SpreadR
		art.Summary.FinancingR += t.FinancingR
		art.Summary.MeanEntrySpread += t.EntrySpread / float64(len(art.Trades))
	}
	art.Summary.Net = backtest.Summarize(net)
	return art
}

// Replay loads the data against the spec and runs it. The artifact carries the spec and
// data sha256.
func Replay(specJSON []byte, data io.Reader) (Spec, Artifact, error) {
	s, err := ParseSpec(specJSON)
	if err != nil {
		return s, Artifact{}, err
	}
	bid, ask, err := Load(s, data)
	if err != nil {
		return s, Artifact{}, err
	}
	art := Run(s, bid, ask)
	sum := sha256.Sum256(specJSON)
	art.SpecSHA256 = hex.EncodeToString(sum[:])
	art.DataSHA256 = s.Dataset.SHA256
	return s, art, nil
}

// Execute replays the spec on the data and returns the artifact as JSON.
func Execute(specJSON []byte, data io.Reader) ([]byte, error) {
	_, art, err := Replay(specJSON, data)
	if err != nil {
		return nil, err
	}
	out, err := json.MarshalIndent(art, "", "  ")
	if err != nil {
		return nil, err
	}
	return append(out, '\n'), nil
}
