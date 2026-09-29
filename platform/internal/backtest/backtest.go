// Package backtest replays historical Supertrend flips with candidate risk and
// filter settings. It measures a rule family, not a strategy prompt: a prompt is
// judged by a model and cannot be replayed deterministically. The result is
// evidence for which filters and stop sizes help flips on one instrument.
//
// Conventions that keep the numbers honest:
//   - A flip is known at the close of its bar. The trade enters at the next bar's open.
//   - The stop is checked before the target inside one bar, the pessimistic order.
//   - Results are in R, the multiples of the initial stop distance, so instruments compare.
//   - Trades split chronologically into a training part and a test part. Settings are
//     chosen on training only, and the test part is what the caller should trust.
package backtest

import (
	"math"
	"sort"
	"time"
)

type Candle struct {
	Time                           time.Time
	Open, High, Low, Close, Volume float64 // Volume 0 means unknown
}

type Flip struct {
	Time time.Time // open time of the bar whose close confirmed the flip
	Dir  int       // +1 buy, -1 sell
}

// Params are one candidate setting. Zero means the option is off.
type Params struct {
	StopATR   float64 `json:"stopAtr"`
	RR        float64 `json:"rr"`      // target as a multiple of the stop distance
	MaxBars   int     `json:"maxBars"` // time stop
	MinADX    float64 `json:"minAdx"`
	MinVolume float64 `json:"minVolume"` // volume ratio against the prior 20 bars
	Direction string  `json:"direction"` // both | long | short
}

type Trade struct {
	Entry  time.Time
	Dir    int
	R      float64
	Reason string // stop | target | time | reversal | end
}

type Stats struct {
	Trades     int     `json:"trades"`
	WinRate    float64 `json:"winRate"`
	Expectancy float64 `json:"expectancy"` // mean R per trade
	TotalR     float64 `json:"totalR"`
	ProfitFac  float64 `json:"profitFactor"` // 0 when there are no losses and no wins
	MaxDD      float64 `json:"maxDrawdownR"`
}

const (
	period    = 14
	volWindow = 20
	warmup    = 3 * period // indicators need history before they are meaningful
)

type features struct{ atr, adx, vol []float64 }

// indicators computes Wilder ATR and ADX and the volume ratio for every bar.
func indicators(c []Candle) features {
	n := len(c)
	f := features{atr: make([]float64, n), adx: make([]float64, n), vol: make([]float64, n)}
	if n <= period+1 {
		return f
	}
	tr := make([]float64, n)
	pdm := make([]float64, n)
	mdm := make([]float64, n)
	for i := 1; i < n; i++ {
		h, l, pc := c[i].High, c[i].Low, c[i-1].Close
		tr[i] = math.Max(h-l, math.Max(math.Abs(h-pc), math.Abs(l-pc)))
		up, dn := h-c[i-1].High, c[i-1].Low-l
		if up > dn && up > 0 {
			pdm[i] = up
		}
		if dn > up && dn > 0 {
			mdm[i] = dn
		}
	}
	var sTR, sP, sM float64
	for i := 1; i <= period; i++ {
		sTR, sP, sM = sTR+tr[i], sP+pdm[i], sM+mdm[i]
	}
	dx := make([]float64, n)
	calc := func(i int) {
		if sTR == 0 {
			return
		}
		pdi, mdi := 100*sP/sTR, 100*sM/sTR
		if pdi+mdi > 0 {
			dx[i] = 100 * math.Abs(pdi-mdi) / (pdi + mdi)
		}
	}
	f.atr[period] = sTR / period
	calc(period)
	for i := period + 1; i < n; i++ {
		sTR = sTR - sTR/period + tr[i]
		sP = sP - sP/period + pdm[i]
		sM = sM - sM/period + mdm[i]
		f.atr[i] = sTR / period
		calc(i)
	}
	// ADX is the Wilder average of DX, seeded with the mean of the first `period` values
	if n > 2*period {
		var s float64
		for i := period; i < 2*period; i++ {
			s += dx[i]
		}
		f.adx[2*period-1] = s / period
		for i := 2 * period; i < n; i++ {
			f.adx[i] = (f.adx[i-1]*(period-1) + dx[i]) / period
		}
	}
	for i := volWindow; i < n; i++ {
		var s float64
		k := 0
		for j := i - volWindow; j < i; j++ {
			if c[j].Volume > 0 {
				s += c[j].Volume
				k++
			}
		}
		if k >= volWindow/2 && s > 0 && c[i].Volume > 0 {
			f.vol[i] = c[i].Volume / (s / float64(k))
		}
	}
	return f
}

// Run replays the flips with one setting. Candles must be ascending and complete.
func Run(c []Candle, flips []Flip, p Params) []Trade {
	f := indicators(c)
	return runWith(c, f, flips, p)
}

func runWith(c []Candle, f features, flips []Flip, p Params) []Trade {
	idx := make(map[int64]int, len(c))
	for i, k := range c {
		idx[k.Time.Unix()] = i
	}
	// bar index of every flip, for reversal exits
	flipBar := map[int]int{}
	for _, fl := range flips {
		if i, ok := idx[fl.Time.Unix()]; ok {
			flipBar[i] = fl.Dir
		}
	}
	maxBars := p.MaxBars
	if maxBars <= 0 {
		maxBars = 200
	}
	var out []Trade
	busyUntil := -1 // one position at a time, like the bot
	for _, fl := range flips {
		i, ok := idx[fl.Time.Unix()]
		if !ok || i < warmup || i+1 >= len(c) || i <= busyUntil {
			continue
		}
		if (p.Direction == "long" && fl.Dir < 0) || (p.Direction == "short" && fl.Dir > 0) {
			continue
		}
		atr := f.atr[i]
		if atr <= 0 || f.adx[i] < p.MinADX || (p.MinVolume > 0 && f.vol[i] < p.MinVolume) {
			continue
		}
		entry := c[i+1].Open
		dist := p.StopATR * atr
		if dist <= 0 {
			continue
		}
		d := float64(fl.Dir)
		stop, target := entry-d*dist, 0.0
		if p.RR > 0 {
			target = entry + d*p.RR*dist
		}
		tr := Trade{Entry: c[i+1].Time, Dir: fl.Dir, Reason: "end"}
		exit := c[len(c)-1].Close
		last := len(c) - 1
		for j := i + 1; j < len(c) && j <= i+maxBars; j++ {
			b := c[j]
			hitStop := (d > 0 && b.Low <= stop) || (d < 0 && b.High >= stop)
			hitTarget := target != 0 && ((d > 0 && b.High >= target) || (d < 0 && b.Low <= target))
			switch {
			case hitStop:
				exit, tr.Reason, last = stop, "stop", j
			case hitTarget:
				exit, tr.Reason, last = target, "target", j
			case flipBar[j] == -fl.Dir && j > i+1 && flipBar[j] != 0:
				exit, tr.Reason, last = b.Close, "reversal", j
			case j == i+maxBars:
				exit, tr.Reason, last = b.Close, "time", j
			default:
				continue
			}
			break
		}
		if tr.Reason == "end" {
			last = len(c) - 1
		}
		tr.R = d * (exit - entry) / dist
		busyUntil = last
		out = append(out, tr)
	}
	return out
}

// Summarize reduces trades to the numbers a trader compares.
func Summarize(t []Trade) Stats {
	s := Stats{Trades: len(t)}
	if len(t) == 0 {
		return s
	}
	var win, loss, cum, peak float64
	wins := 0
	for _, x := range t {
		s.TotalR += x.R
		if x.R > 0 {
			wins++
			win += x.R
		} else {
			loss -= x.R
		}
		cum += x.R
		peak = math.Max(peak, cum)
		s.MaxDD = math.Max(s.MaxDD, peak-cum)
	}
	s.WinRate = float64(wins) / float64(len(t))
	s.Expectancy = s.TotalR / float64(len(t))
	if loss > 0 {
		s.ProfitFac = win / loss
	} else if win > 0 {
		s.ProfitFac = 99
	}
	return s
}

// Split cuts trades chronologically: the first `frac` of them are training, the rest are test.
func Split(t []Trade, frac float64) (train, test []Trade) {
	sort.Slice(t, func(a, b int) bool { return t[a].Entry.Before(t[b].Entry) })
	k := int(math.Round(float64(len(t)) * frac))
	return t[:k], t[k:]
}

type Candidate struct {
	Params Params `json:"params"`
	Train  Stats  `json:"train"`
	Test   Stats  `json:"test"`
}

type Report struct {
	Baseline   Candidate   `json:"baseline"`
	Candidates []Candidate `json:"candidates"` // best on training first
	Tried      int         `json:"tried"`
	Flips      int         `json:"flips"`
	From, To   time.Time   `json:"-"`
}

const (
	MinTrain = 30
	MinTest  = 10
)

func evaluate(c []Candle, f features, flips []Flip, p Params) Candidate {
	tr, te := Split(runWith(c, f, flips, p), 0.7)
	return Candidate{Params: p, Train: Summarize(tr), Test: Summarize(te)}
}

// Grid is deliberately small. Every extra setting tried raises the chance that the
// best one only looks good by luck, so the caller must judge candidates on the test part.
func Grid() []Params {
	var g []Params
	for _, stop := range []float64{1, 1.5, 2, 3} {
		for _, rr := range []float64{0, 1.5, 2, 3} {
			for _, adx := range []float64{0, 20, 25, 30} {
				for _, vol := range []float64{0, 1, 1.3} {
					g = append(g, Params{StopATR: stop, RR: rr, MinADX: adx, MinVolume: vol, Direction: "both"})
				}
			}
		}
	}
	return g
}

// Search evaluates the grid and returns the top settings by training expectancy,
// among those with enough training trades, next to the plain-flip baseline.
func Search(c []Candle, flips []Flip, top int) Report {
	f := indicators(c)
	base := evaluate(c, f, flips, Params{StopATR: 1.5, RR: 2, Direction: "both"})
	r := Report{Baseline: base, Flips: len(flips)}
	var all []Candidate
	for _, p := range Grid() {
		cd := evaluate(c, f, flips, p)
		r.Tried++
		if cd.Train.Trades >= MinTrain {
			all = append(all, cd)
		}
	}
	sort.SliceStable(all, func(a, b int) bool { return all[a].Train.Expectancy > all[b].Train.Expectancy })
	if len(all) > top {
		all = all[:top]
	}
	r.Candidates = all
	return r
}

// Holds reports whether a candidate beat the baseline on the test part, with enough test trades to mean something.
func (r Report) Holds(c Candidate) bool {
	return c.Test.Trades >= MinTest && c.Test.Expectancy > r.Baseline.Test.Expectancy && c.Test.Expectancy > 0
}
