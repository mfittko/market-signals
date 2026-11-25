package research

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"math"
	"math/rand/v2"
	"slices"
	"strings"
	"time"

	"github.com/mfittko/market-signals/platform/internal/backtest"
)

// Values is a declared list of numbers with its provenance.
type Values struct {
	Values []float64 `json:"values"`
	Label  string    `json:"label"`
	Source string    `json:"source"`
}

// BBSpec is the frozen contract of the Bollinger band study. It references the E0 spec,
// whose rules, fills and costs every instrument inherits.
type BBSpec struct {
	ID        string   `json:"id"`
	Questions []string `json:"questions"`
	E0Spec    struct {
		Path   string `json:"path"`
		SHA256 string `json:"sha256"`
	} `json:"e0Spec"`
	Instruments []struct {
		Instrument string `json:"instrument"`
		Dataset    struct {
			Path   string  `json:"path"`
			SHA256 *string `json:"sha256"` // null until the export exists
		} `json:"dataset"`
	} `json:"instruments"`
	Inherited Note `json:"inherited"`
	Analysis  struct {
		MinRows         Value  `json:"minRows"`
		NotRun          Note   `json:"notRun"`
		BandPeriod      Value  `json:"bandPeriod"`
		BandStdDevs     Value  `json:"bandStdDevs"`
		Bands           Note   `json:"bands"`
		Spread          Note   `json:"spread"`
		WidthThresholds Values `json:"widthThresholds"`
		CostDrag        Note   `json:"costDrag"`
		WalkLengths     Values `json:"walkLengths"`
		Walk            Note   `json:"walk"`
		WalkTargetR     Value  `json:"walkTargetR"`
		WalkMaxBars     Value  `json:"walkMaxBars"`
		SqueezeLookback Value  `json:"squeezeLookback"`
		SqueezeShare    Value  `json:"squeezeShare"`
		Squeeze         Note   `json:"squeeze"`
		Random          Note   `json:"random"`
		Days            Note   `json:"days"`
		BlockDays       Value  `json:"blockDays"`
		BootstrapReps   Value  `json:"bootstrapReps"`
		Seed            Value  `json:"seed"`
		Metric          Note   `json:"metric"`
		Decisions       Value  `json:"decisions"`
		CI              Note   `json:"ci"`
	} `json:"analysis"`
	DecisionRule struct {
		CostDrag         string `json:"costDrag"`
		Walks            string `json:"walks"`
		RandomPercentile string `json:"randomPercentile"`
		Label            string `json:"label"`
		Source           string `json:"source"`
	} `json:"decisionRule"`
}

// declared lists every labelled spec entry with its printed value, for the check and the report.
func (s BBSpec) declared() []struct{ name, value, label, source string } {
	a := s.Analysis
	num := func(v Value) string { return fmt.Sprint(v.Value) }
	list := func(v Values) string { return strings.Trim(fmt.Sprint(v.Values), "[]") }
	return []struct{ name, value, label, source string }{
		{"inherited", "E0 rules", s.Inherited.Label, s.Inherited.Source},
		{"minRows", num(a.MinRows), a.MinRows.Label, a.MinRows.Source},
		{"notRun", "rule", a.NotRun.Label, a.NotRun.Source},
		{"bandPeriod", num(a.BandPeriod), a.BandPeriod.Label, a.BandPeriod.Source},
		{"bandStdDevs", num(a.BandStdDevs), a.BandStdDevs.Label, a.BandStdDevs.Source},
		{"bands", "rule", a.Bands.Label, a.Bands.Source},
		{"spread", "rule", a.Spread.Label, a.Spread.Source},
		{"widthThresholds", list(a.WidthThresholds), a.WidthThresholds.Label, a.WidthThresholds.Source},
		{"costDrag", "rule", a.CostDrag.Label, a.CostDrag.Source},
		{"walkLengths", list(a.WalkLengths), a.WalkLengths.Label, a.WalkLengths.Source},
		{"walk", "rule", a.Walk.Label, a.Walk.Source},
		{"walkTargetR", num(a.WalkTargetR), a.WalkTargetR.Label, a.WalkTargetR.Source},
		{"walkMaxBars", num(a.WalkMaxBars), a.WalkMaxBars.Label, a.WalkMaxBars.Source},
		{"squeezeLookback", num(a.SqueezeLookback), a.SqueezeLookback.Label, a.SqueezeLookback.Source},
		{"squeezeShare", num(a.SqueezeShare), a.SqueezeShare.Label, a.SqueezeShare.Source},
		{"squeeze", "rule", a.Squeeze.Label, a.Squeeze.Source},
		{"random", "rule", a.Random.Label, a.Random.Source},
		{"days", "rule", a.Days.Label, a.Days.Source},
		{"blockDays", num(a.BlockDays), a.BlockDays.Label, a.BlockDays.Source},
		{"bootstrapReps", num(a.BootstrapReps), a.BootstrapReps.Label, a.BootstrapReps.Source},
		{"seed", num(a.Seed), a.Seed.Label, a.Seed.Source},
		{"metric", "rule", a.Metric.Label, a.Metric.Source},
		{"decisions", num(a.Decisions), a.Decisions.Label, a.Decisions.Source},
		{"ci", "rule", a.CI.Label, a.CI.Source},
		{"decisionRule", "rule", s.DecisionRule.Label, s.DecisionRule.Source},
	}
}

// ParseBBSpec decodes the spec and refuses an unknown field, an unlabelled value, a
// count that is not a whole number >= 1, walk lengths that are not ascending and distinct,
// a bad band, threshold or squeeze value, and a decision count other than one per
// threshold plus two per walk length.
func ParseBBSpec(b []byte) (BBSpec, error) {
	var s BBSpec
	d := json.NewDecoder(bytes.NewReader(b))
	d.DisallowUnknownFields()
	if err := d.Decode(&s); err != nil {
		return s, fmt.Errorf("bb spec: %w", err)
	}
	for _, v := range s.declared() {
		if (v.label != "assumed" && v.label != "measured") || v.source == "" {
			return s, fmt.Errorf("bb spec: %s must be labelled assumed or measured, with a source", v.name)
		}
	}
	a := s.Analysis
	notWhole := func(v float64) bool { return v < 1 || v != math.Trunc(v) }
	counts := slices.Concat([]float64{a.MinRows.Value, a.BandPeriod.Value, a.WalkMaxBars.Value, a.SqueezeLookback.Value, a.BlockDays.Value, a.BootstrapReps.Value, a.Decisions.Value}, a.WalkLengths.Values)
	if len(a.WalkLengths.Values) == 0 || slices.ContainsFunc(counts, notWhole) {
		return s, errors.New("bb spec: minRows, bandPeriod, walkMaxBars, squeezeLookback, blockDays, bootstrapReps, decisions and every walk length must be whole numbers >= 1")
	}
	switch th := a.WidthThresholds.Values; {
	case len(th) == 0 || th[0] <= 0 || !slices.IsSorted(th) || len(slices.Compact(slices.Clone(th))) != len(th):
		return s, errors.New("bb spec: widthThresholds must be ascending, distinct and > 0")
	case !slices.IsSorted(a.WalkLengths.Values) || len(slices.Compact(slices.Clone(a.WalkLengths.Values))) != len(a.WalkLengths.Values):
		return s, errors.New("bb spec: walkLengths must be ascending and distinct")
	case a.BandStdDevs.Value <= 0 || a.WalkTargetR.Value <= 0:
		return s, errors.New("bb spec: bandStdDevs and walkTargetR must be > 0")
	case a.SqueezeShare.Value <= 0 || a.SqueezeShare.Value >= 1:
		return s, errors.New("bb spec: squeezeShare must be between 0 and 1")
	case a.Seed.Value < 0 || a.Seed.Value != math.Trunc(a.Seed.Value):
		return s, errors.New("bb spec: analysis.seed must be a whole number >= 0")
	case int(a.Decisions.Value) != len(th)+2*len(a.WalkLengths.Values):
		return s, fmt.Errorf("bb spec: decisions %v, want one per width threshold plus two per walk length (%d)", a.Decisions.Value, len(th)+2*len(a.WalkLengths.Values))
	}
	return s, nil
}

// bollinger returns the middle band and the width of each bar from the closes of that
// bar and the period-1 bars before it; both are NaN for a bar with too few bars.
func bollinger(bid []backtest.Candle, period int, k float64) (mid, width []float64) {
	mid, width = make([]float64, len(bid)), make([]float64, len(bid))
	for t := range bid {
		if t < period-1 {
			mid[t], width[t] = math.NaN(), math.NaN()
			continue
		}
		m := 0.0
		for _, c := range bid[t-period+1 : t+1] {
			m += c.Close
		}
		m /= float64(period)
		v := 0.0
		for _, c := range bid[t-period+1 : t+1] {
			v += (c.Close - m) * (c.Close - m)
		}
		mid[t], width[t] = m, 2*k*math.Sqrt(v/float64(period))
	}
	return mid, width
}

// weightedMean is the mean of vals[x] over the x that sel keeps, each weighted by
// w[day[x]]; ok is false when the kept weights sum to 0.
func weightedMean(vals []float64, day []int, w []float64, sel func(int) bool) (float64, bool) {
	s, c := 0.0, 0.0
	for x, v := range vals {
		if sel(x) {
			s += w[day[x]] * v
			c += w[day[x]]
		}
	}
	if c == 0 {
		return 0, false
	}
	return s / c, true
}

// Bucket is one band-width bucket of question 1; Net, Gross and Spread are mean R with a
// 95% CI.
type Bucket struct {
	Name               string
	Trades             int
	Net, Gross, Spread Interval
	Financing          float64
}

// Gate is one width threshold k of question 1: the kept trades have a width of k spreads
// or more.
type Gate struct {
	K        float64
	Kept     int
	Share    float64
	Delta    Interval // kept mean net R minus the mean net R of all scored trades
	Decision string
}

// WalkGroup is one subgroup of the walks of one length.
type WalkGroup struct {
	Name      string
	Trades    int
	WalkMean  float64
	Delta     Interval // walk mean net R minus random mean net R
	RandomPct float64  // share of draws whose mean is below the walk mean, in percent
	Decision  string   // empty for a descriptive subgroup
}

// Walk holds the band walks of one length N.
type Walk struct {
	N                     int
	Signals, Busy, NoStop int
	NoEntryBar            int
	Groups                []WalkGroup
}

// BBResult holds every number the report prints for one instrument.
type BBResult struct {
	Instrument string
	Rows, Days int
	E0Trades   int
	NoBand     int // E0 trades whose flip bar has no band
	Buckets    []Bucket
	Gates      []Gate
	Walks      []Walk
}

// NotRun is an instrument the study skipped, with the reason.
type NotRun struct {
	Instrument, Reason string
}

// BBArtifact is the deterministic result of one run; the report prints its sha256.
type BBArtifact struct {
	Experiment   string     `json:"experiment"`
	SpecSHA256   string     `json:"specSha256"`
	E0SpecSHA256 string     `json:"e0SpecSha256"`
	Results      []BBResult `json:"results"`
	NotRun       []NotRun   `json:"notRun"`
}

// AnalyzeBB answers both questions for one instrument. e0 is the instrument's copy of the
// E0 spec. One PCG stream seeded by the spec draws the bootstrap replicates and then the
// random draws, walk length by walk length.
func AnalyzeBB(s BBSpec, e0 Spec, bid, ask []backtest.Candle) BBResult {
	a := s.Analysis
	res := BBResult{Instrument: e0.Instrument.Name, Rows: len(bid)}
	mid, width := bollinger(bid, int(a.BandPeriod.Value), a.BandStdDevs.Value)
	barDay := make([]int, len(bid))
	for t, c := range bid {
		if t > 0 && c.Time.UTC().Format(time.DateOnly) != bid[t-1].Time.UTC().Format(time.DateOnly) {
			res.Days++
		}
		barDay[t] = res.Days
	}
	if len(bid) > 0 {
		res.Days++
	}
	rng := rand.New(rand.NewPCG(uint64(a.Seed.Value), uint64(a.Seed.Value)))
	reps := dayBlocks(rng, res.Days, int(a.BlockDays.Value), int(a.BootstrapReps.Value))
	weights := make([][]float64, len(reps))
	for i, r := range reps {
		weights[i] = make([]float64, res.Days)
		for _, d := range r {
			weights[i][d]++
		}
	}
	ones := make([]float64, res.Days)
	for d := range ones {
		ones[d] = 1
	}
	level := 100 - 5/a.Decisions.Value
	meanCI := func(vals []float64, day []int, sel func(int) bool) (Interval, int) {
		n := 0
		for x := range vals {
			if sel(x) {
				n++
			}
		}
		if n == 0 {
			return Interval{}, 0
		}
		est, _ := weightedMean(vals, day, ones, sel)
		var rs []float64
		for _, w := range weights {
			if m, ok := weightedMean(vals, day, w, sel); ok {
				rs = append(rs, m)
			}
		}
		return interval(est, rs, 95), n
	}
	at := func(t time.Time) int {
		i, _ := slices.BinarySearchFunc(bid, t, func(c backtest.Candle, t time.Time) int { return c.Time.Compare(t) })
		return i
	}

	// question 1: band width at each E0 entry, in spreads
	var net, gross, spread, fin, ratio []float64
	var day []int
	for _, tr := range Run(e0, bid, ask).Trades {
		res.E0Trades++
		i, j := at(tr.Flip), at(tr.Entry)
		if math.IsNaN(width[i]) {
			res.NoBand++
			continue
		}
		r := math.Inf(1)
		if sp := ask[j].Open - bid[j].Open; sp > 0 {
			r = width[i] / sp
		}
		net, gross, spread, fin, ratio = append(net, tr.NetR), append(gross, tr.GrossR), append(spread, tr.SpreadR), append(fin, tr.FinancingR), append(ratio, r)
		day = append(day, barDay[j])
	}
	th := a.WidthThresholds.Values
	bucketOf := func(x int) int {
		n := 0
		for _, k := range th {
			if ratio[x] >= k {
				n++
			}
		}
		return n
	}
	for b := range len(th) + 1 {
		name := fmt.Sprintf("%g to %g", th[max(b-1, 0)], th[min(b, len(th)-1)])
		switch b {
		case 0:
			name = fmt.Sprintf("below %g", th[0])
		case len(th):
			name = fmt.Sprintf("%g or more", th[len(th)-1])
		}
		in := func(x int) bool { return bucketOf(x) == b }
		bk := Bucket{Name: name}
		bk.Net, bk.Trades = meanCI(net, day, in)
		bk.Gross, _ = meanCI(gross, day, in)
		bk.Spread, _ = meanCI(spread, day, in)
		if f, ok := weightedMean(fin, day, ones, in); ok {
			bk.Financing = f
		}
		res.Buckets = append(res.Buckets, bk)
	}
	everyTrade := func(int) bool { return true }
	for _, k := range th {
		kept := func(x int) bool { return ratio[x] >= k }
		g := Gate{K: k}
		for x := range ratio {
			if kept(x) {
				g.Kept++
			}
		}
		if len(ratio) > 0 {
			g.Share = float64(g.Kept) / float64(len(ratio))
		}
		if g.Kept > 0 {
			keptMean, _ := weightedMean(net, day, ones, kept)
			all, _ := weightedMean(net, day, ones, everyTrade)
			var rs []float64
			for _, w := range weights {
				km, ok := weightedMean(net, day, w, kept)
				am, _ := weightedMean(net, day, w, everyTrade)
				if ok {
					rs = append(rs, km-am)
				}
			}
			g.Delta = interval(keptMean-all, rs, level)
		}
		g.Decision = decide(g.Delta, "reduces cost drag", "raises cost drag")
		res.Gates = append(res.Gates, g)
	}

	// question 2: band walks against random entries
	ws := e0
	ws.Experiment.Strategy.RR, ws.Experiment.Strategy.MaxBars = a.WalkTargetR.Value, int(a.WalkMaxBars.Value)
	bar := time.Duration(e0.Feed.BarSeconds) * time.Second
	delay := time.Duration(e0.Experiment.Timing.DecisionDelayMs.Value * float64(time.Millisecond))
	hourBars := barsByHour(bid)
	lookback := int(a.SqueezeLookback.Value)
	for _, nv := range a.WalkLengths.Values {
		n := int(nv)
		wk := Walk{N: n}
		var plans []plan
		var wnet []float64
		var wday []int
		var squeeze []bool
		busy := -1
		for _, sg := range walkSignals(bid, mid, width, n) {
			t, dir := sg[0], sg[1]
			wk.Signals++
			if t <= busy {
				wk.Busy++
				continue
			}
			decision := bid[t].Time.Add(bar + delay)
			j := actAt(bid, t+1, decision)
			if j >= len(bid) {
				wk.NoEntryBar++
				continue
			}
			dist := float64(dir) * (entryPrice(bid, ask, j, dir) - mid[t])
			if !(dist > 0) {
				wk.NoStop++
				continue
			}
			p := plan{i: t, j: j, dir: dir, dist: dist, decision: decision}
			tr, last := simulate(ws, bid, ask, nil, p)
			busy = last
			plans, wnet, wday = append(plans, p), append(wnet, tr.NetR), append(wday, barDay[j])
			squeeze = append(squeeze, squeezeStart(width, t-n, lookback, int(a.BandPeriod.Value), a.SqueezeShare.Value))
		}
		type group struct {
			name   string
			sel    func(int) bool
			decide bool
		}
		groups := []group{
			{"all walks", everyTrade, true},
			{"squeeze-start walks", func(x int) bool { return squeeze[x] }, true},
			{"other walks", func(x int) bool { return !squeeze[x] }, false},
			{"longs", func(x int) bool { return plans[x].dir > 0 }, false},
			{"shorts", func(x int) bool { return plans[x].dir < 0 }, false},
		}
		out := make([]WalkGroup, len(groups))
		for g, gr := range groups {
			out[g].Name = gr.name
			for x := range plans {
				if gr.sel(x) {
					out[g].Trades++
				}
			}
			out[g].WalkMean, _ = weightedMean(wnet, wday, ones, gr.sel)
		}
		deltas := make([][]float64, len(groups))
		below := make([]int, len(groups))
		drawSum := make([]float64, len(groups))
		rnet, rday := make([]float64, len(plans)), make([]int, len(plans))
		for _, w := range weights {
			for x, p := range plans {
				rp := randomPlan(rng, bid, &hourBars, p)
				tr, _ := simulate(ws, bid, ask, nil, rp)
				rnet[x], rday[x] = tr.NetR, barDay[rp.j]
			}
			for g, gr := range groups {
				if out[g].Trades == 0 {
					continue
				}
				rm, _ := weightedMean(rnet, rday, ones, gr.sel)
				drawSum[g] += rm
				if rm < out[g].WalkMean {
					below[g]++
				}
				wr, ok1 := weightedMean(wnet, wday, w, gr.sel)
				rr, ok2 := weightedMean(rnet, rday, w, gr.sel)
				if ok1 && ok2 {
					deltas[g] = append(deltas[g], wr-rr)
				}
			}
		}
		for g, gr := range groups {
			wg := &out[g]
			if wg.Trades > 0 && len(weights) > 0 {
				wg.Delta = interval(wg.WalkMean-drawSum[g]/float64(len(weights)), deltas[g], level)
				wg.RandomPct = 100 * float64(below[g]) / float64(len(weights))
			}
			if gr.decide {
				wg.Decision = decide(wg.Delta, "beats random", "loses to random")
			}
		}
		wk.Groups = out
		res.Walks = append(res.Walks, wk)
	}
	return res
}

// barsByHour lists the bar indexes of each UTC hour.
func barsByHour(bid []backtest.Candle) [24][]int {
	var out [24][]int
	for t, c := range bid {
		h := c.Time.UTC().Hour()
		out[h] = append(out[h], t)
	}
	return out
}

// randomPlan is the random twin of walk plan p: it enters at the open of a bar drawn from
// the bars of p's entry UTC hour, with p's side and stop distance.
func randomPlan(rng *rand.Rand, bid []backtest.Candle, hourBars *[24][]int, p plan) plan {
	hb := hourBars[bid[p.j].Time.UTC().Hour()]
	j := hb[rng.IntN(len(hb))]
	return plan{i: j, j: j, dir: p.dir, dist: p.dist, decision: bid[j].Time}
}

// decide reads a delta interval: above when it lies above 0, below when below 0.
func decide(d Interval, above, below string) string {
	switch {
	case d.OK && d.Lo > 0:
		return above
	case d.OK && d.Hi < 0:
		return below
	}
	return "insufficient evidence"
}

// BBInputs are one run's specs, a dataset opener that returns an fs.ErrNotExist error
// for a missing export, and the Go version and platform the report records.
type BBInputs struct {
	BBJSON, E0JSON []byte
	Open           func(path string) (io.ReadCloser, error)
	Platform       string
}

// RunBB checks the E0 spec against the reference, runs every instrument that has an
// export and returns the markdown report and the artifact JSON.
func RunBB(in BBInputs) (report, artifact []byte, err error) {
	s, err := ParseBBSpec(in.BBJSON)
	if err != nil {
		return nil, nil, err
	}
	e0sum := sha256.Sum256(in.E0JSON)
	if got := hex.EncodeToString(e0sum[:]); got != s.E0Spec.SHA256 {
		return nil, nil, fmt.Errorf("e0 spec: sha256 %s, reference %s; restore %s or change the reference in a reviewed commit", got, s.E0Spec.SHA256, s.E0Spec.Path)
	}
	e0, err := ParseSpec(in.E0JSON)
	if err != nil {
		return nil, nil, err
	}
	sum := sha256.Sum256(in.BBJSON)
	art := BBArtifact{Experiment: s.ID, SpecSHA256: hex.EncodeToString(sum[:]), E0SpecSHA256: s.E0Spec.SHA256, Results: []BBResult{}, NotRun: []NotRun{}}
	for _, inst := range s.Instruments {
		f, err := in.Open(inst.Dataset.Path)
		if errors.Is(err, fs.ErrNotExist) {
			art.NotRun = append(art.NotRun, NotRun{inst.Instrument, "no export"})
			continue
		}
		if err != nil {
			return nil, nil, err
		}
		if inst.Dataset.SHA256 == nil {
			f.Close()
			art.NotRun = append(art.NotRun, NotRun{inst.Instrument, "no dataset sha256 in the spec"})
			continue
		}
		ie := e0
		ie.Instrument.Name = inst.Instrument
		_, ie.Instrument.QuoteCurrency, _ = strings.Cut(inst.Instrument, "/")
		ie.Dataset.Path, ie.Dataset.SHA256 = inst.Dataset.Path, *inst.Dataset.SHA256
		bid, ask, err := Load(ie, f)
		f.Close()
		if err != nil {
			return nil, nil, fmt.Errorf("%s: %w", inst.Instrument, err)
		}
		if len(bid) < int(s.Analysis.MinRows.Value) {
			art.NotRun = append(art.NotRun, NotRun{inst.Instrument, fmt.Sprintf("%d rows, under %v", len(bid), s.Analysis.MinRows.Value)})
			continue
		}
		art.Results = append(art.Results, AnalyzeBB(s, ie, bid, ask))
	}
	artifact, err = json.MarshalIndent(art, "", "  ")
	if err != nil {
		return nil, nil, err
	}
	artifact = append(artifact, '\n')
	return renderBB(s, e0, art, artifact, in.Platform), artifact, nil
}

func renderBB(s BBSpec, e0 Spec, art BBArtifact, artifact []byte, platform string) []byte {
	var b strings.Builder
	p := func(format string, args ...any) { fmt.Fprintf(&b, format, args...) }
	a, st := s.Analysis, e0.Experiment.Strategy
	sum := sha256.Sum256(artifact)
	p("# %s: Bollinger band width and band walks under E0 costs\n\n", s.ID)
	p("This report claims no edge and no profitable strategy. Its only conclusions are the preregistered decisions below. It is generated by `platform/cmd/research-bb` from the frozen spec and the exports that the tables pin by sha256.\n\n")
	p("Questions:\n\n")
	for k, q := range s.Questions {
		p("%d. %s\n", k+1, q)
	}
	p("\n## Inputs\n\n| Item | Value |\n|---|---|\n")
	p("| BB spec | `docs/research/experiments/bb/spec.json`, sha256 `%s` |\n", art.SpecSHA256)
	p("| E0 spec | `%s`, sha256 `%s` |\n", s.E0Spec.Path, s.E0Spec.SHA256)
	p("| Artifact sha256 | `%s` |\n", hex.EncodeToString(sum[:]))
	p("| Go version and platform | `%s` |\n\n", platform)
	p("The artifact is the JSON of every result below at full precision. Its sha256 reproduces on that Go version and platform; another GOARCH can change it, because the Go compiler may fuse a multiply and an add on arm64. The exports are one-time owner exports and are not committed.\n\n")

	p("## Instruments\n\n| Instrument | Export | Dataset sha256 | Status |\n|---|---|---|---|\n")
	for _, inst := range s.Instruments {
		h, status := "null", "run"
		if inst.Dataset.SHA256 != nil {
			h = "`" + *inst.Dataset.SHA256 + "`"
		}
		for _, n := range art.NotRun {
			if n.Instrument == inst.Instrument {
				status = "not run: " + n.Reason
			}
		}
		p("| %s | `%s` | %s | %s |\n", inst.Instrument, inst.Dataset.Path, h, status)
	}

	p("\n## Rules\n\nThe rules are preregistered in the [BB spec](spec.json). Each instrument copies the [E0 spec](../e0/spec.json) and changes only its instrument and dataset: %s. Question 1 scores the E0 trades (Supertrend %d/%g, %.1f ATR stop, %.0f R target, reversal, %d-bar time stop). Question 2 enters on band walks with the stop at the middle band, a %.0f R target, a %.0f-bar time stop and no reversal exit. Both use the E0 fills, spread and financing.\n\n",
		s.Inherited.Rule, st.SupertrendPeriod, st.SupertrendMult, st.StopATR, st.RR, st.MaxBars, a.WalkTargetR.Value, a.WalkMaxBars.Value)
	p("## Declared values\n\nEvery value of the study is labelled in the spec. A rule's text is in the spec.\n\n| Name | Value | Label | Source |\n|---|---|---|---|\n")
	for _, v := range s.declared() {
		p("| %s | %s | %s | %s |\n", v.name, v.value, v.label, v.source)
	}

	for _, r := range art.Results {
		p("\n## %s\n\n%d rows over %d UTC days. E0 trades: %d; %d have no band at the flip bar and are left out of question 1.\n\n", r.Instrument, r.Rows, r.Days, r.E0Trades, r.NoBand)
		p("### Question 1: band width at the E0 entry\n\nWidth in spreads is the flip bar's band width over the entry-open spread. Means are in R per trade with a 95%% block-bootstrap CI. Gross minus spread minus financing is net.\n\n")
		p("| Width in spreads | Trades | Net R [CI] | Gross R [CI] | Spread R [CI] | Financing R |\n|---|---|---|---|---|---|\n")
		for _, bk := range r.Buckets {
			if bk.Trades == 0 {
				p("| %s | 0 | n/a | n/a | n/a | n/a |\n", bk.Name)
				continue
			}
			p("| %s | %d | %s | %s | %s | %+.3f |\n", bk.Name, bk.Trades, ci(bk.Net), ci(bk.Gross), ci(bk.Spread), bk.Financing)
		}
		p("\nGate: keep an E0 trade only when the width is k spreads or more. The interval is the Bonferroni interval over %v decisions.\n\n| k | Kept | Kept share | Kept minus all net R [interval] | Decision |\n|---|---|---|---|---|\n", a.Decisions.Value)
		for _, g := range r.Gates {
			d := "n/a"
			if g.Kept > 0 {
				d = ci(g.Delta)
			}
			p("| %g | %d | %.1f%% | %s | %s |\n", g.K, g.Kept, 100*g.Share, d, g.Decision)
		}
		p("\n### Question 2: band walks against random entries\n\nThe interval is the Bonferroni interval over %v decisions. The random-entry percentile is the share of the %v random draws whose mean net R is below the walk mean; it does not enter the decision. Other walks, longs and shorts get no decision.\n", a.Decisions.Value, a.BootstrapReps.Value)
		for _, w := range r.Walks {
			p("\n#### N = %d\n\nSignals: %d; skipped as busy: %d, no_stop: %d, no_entry_bar: %d.\n\n", w.N, w.Signals, w.Busy, w.NoStop, w.NoEntryBar)
			p("| Group | Trades | Walk mean net R | Walk minus random net R [interval] | Random-entry percentile | Decision |\n|---|---|---|---|---|---|\n")
			for _, g := range w.Groups {
				dec := g.Decision
				if dec == "" {
					dec = "none (descriptive)"
				}
				if g.Trades == 0 {
					p("| %s | 0 | n/a | n/a | n/a | %s |\n", g.Name, dec)
					continue
				}
				p("| %s | %d | %+.3f | %s | %.1f | %s |\n", g.Name, g.Trades, g.WalkMean, ci(g.Delta), g.RandomPct, dec)
			}
		}
	}

	p("\n## Decisions\n\nEach decision follows the preregistered rule in the spec. There are %v decisions per instrument, and no correction runs across instruments.\n\n", a.Decisions.Value)
	if len(art.Results) == 0 {
		p("No instrument was run, so there is no decision.\n")
	}
	for _, r := range art.Results {
		p("%s:\n\n", r.Instrument)
		for _, g := range r.Gates {
			p("- Question 1, k = %g: %s.\n", g.K, g.Decision)
		}
		for _, w := range r.Walks {
			for _, g := range w.Groups {
				if g.Decision != "" {
					p("- Question 2, N = %d, %s: %s.\n", w.N, g.Name, g.Decision)
				}
			}
		}
		p("\n")
	}
	p("Not run:\n\n")
	if len(art.NotRun) == 0 {
		p("- none\n")
	}
	for _, n := range art.NotRun {
		p("- %s: %s.\n", n.Instrument, n.Reason)
	}

	p("\n## Limits\n\n")
	p("- The financing values and the 17:00 America/New_York rollover are the E0 assumptions, applied to every instrument.\n")
	p("- The random baseline matches count, side, UTC hour and stop distance. Volatility and session state beyond the hour are unmatched.\n")
	p("- \"Insufficient evidence\" is no finding of absence.\n")
	p("- Each instrument is one export snapshot over its own date range.\n")
	p("\n## Run\n\nFrom `platform/`:\n\n```\ngo run ./cmd/research-bb --spec ../docs/research/experiments/bb/spec.json --artifact <artifact JSON path> --report <report path>\n```\n\nPublication: build the command, run it twice with the network denied, and publish the report only when both runs give the same artifact sha256 and identical report bytes.\n")
	return []byte(b.String())
}

// walkSignals returns each signal bar and side of the walks of length n: the bar on
// which a run of consecutive closes strictly beyond their own outer band on one side
// reaches n. A run gives at most one signal.
func walkSignals(bid []backtest.Candle, mid, width []float64, n int) [][2]int {
	var out [][2]int
	run, side := 0, 0
	for t, c := range bid {
		dir := 0
		switch {
		case c.Close > mid[t]+width[t]/2:
			dir = 1
		case c.Close < mid[t]-width[t]/2:
			dir = -1
		}
		switch {
		case dir == 0:
			run, side = 0, 0
		case dir == side:
			run++
		default:
			run, side = 1, dir
		}
		if run == n {
			out = append(out, [2]int{t, dir})
		}
	}
	return out
}

// squeezeStart reports whether the width of bar b is in the lowest share of the widths of
// the lookback bars before it, all of which need a band.
func squeezeStart(width []float64, b, lookback, period int, share float64) bool {
	if b-lookback < period-1 {
		return false
	}
	below := 0
	for _, w := range width[b-lookback : b] {
		if w < width[b] {
			below++
		}
	}
	return float64(below) < share*float64(lookback)
}
