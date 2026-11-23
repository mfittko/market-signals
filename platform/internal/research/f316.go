package research

import (
	"bytes"
	"crypto/sha256"
	"encoding/csv"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"maps"
	"math"
	"math/rand/v2"
	"regexp"
	"slices"
	"sort"
	"strings"
	"time"

	"github.com/mfittko/market-signals/platform/internal/backtest"
)

// F316Spec is the frozen contract of the filter-verdict experiment. It references the
// E0 spec, whose rules score every verdict.
type F316Spec struct {
	ID       string `json:"id"`
	Question string `json:"question"`
	Seen     string `json:"seen"`
	E0Spec   struct {
		Path   string `json:"path"`
		SHA256 string `json:"sha256"`
	} `json:"e0Spec"`
	Verdicts struct {
		Path       string    `json:"path"`
		SHA256     string    `json:"sha256"`
		Rows       int       `json:"rows"`
		Instrument string    `json:"instrument"`
		First      time.Time `json:"first"`
		Last       time.Time `json:"last"`
		Export     Note      `json:"export"`
	} `json:"verdicts"`
	Granularities Note `json:"granularities"`
	Categories    struct {
		Note
		List []struct {
			Name  string `json:"name"`
			Regex string `json:"regex"`
		} `json:"list"`
	} `json:"categories"`
	Exclusions Note `json:"exclusions"`
	Analysis   struct {
		Days          Note  `json:"days"`
		BlockDays     Value `json:"blockDays"`
		BootstrapReps Value `json:"bootstrapReps"`
		ThinningDraws Value `json:"thinningDraws"`
		Seed          Value `json:"seed"`
		MinBlocked    Value `json:"minBlocked"`
		CI            Note  `json:"ci"`
		Delta         Note  `json:"delta"`
	} `json:"analysis"`
	DecisionRule struct {
		// decoded for the strict field check only; the report links the spec for them
		Keep, Drop, Otherwise, Thinning string
		LateChasing                     string `json:"lateChasing"`
		Label                           string `json:"label"`
		Source                          string `json:"source"`
	} `json:"decisionRule"`
	Reference struct {
		Label       string     `json:"label"`
		Source      string     `json:"source"`
		Differences string     `json:"differences"`
		Summary     []string   `json:"summary"`
		Header      []string   `json:"header"`
		Rows        [][]string `json:"rows"`
	} `json:"reference"`
}

type category struct {
	name string
	re   *regexp.Regexp
}

// ParseF316Spec decodes the spec, refuses an unknown field, an unlabelled value or a
// non-positive analysis setting, and compiles the reason categories case-insensitively.
func ParseF316Spec(b []byte) (F316Spec, []category, error) {
	var s F316Spec
	d := json.NewDecoder(bytes.NewReader(b))
	d.DisallowUnknownFields()
	if err := d.Decode(&s); err != nil {
		return s, nil, fmt.Errorf("f316 spec: %w", err)
	}
	a := s.Analysis
	labelled := []struct{ name, label, source string }{
		{"verdicts.export", s.Verdicts.Export.Label, s.Verdicts.Export.Source},
		{"granularities", s.Granularities.Label, s.Granularities.Source},
		{"categories", s.Categories.Label, s.Categories.Source},
		{"exclusions", s.Exclusions.Label, s.Exclusions.Source},
		{"analysis.days", a.Days.Label, a.Days.Source},
		{"analysis.blockDays", a.BlockDays.Label, a.BlockDays.Source},
		{"analysis.bootstrapReps", a.BootstrapReps.Label, a.BootstrapReps.Source},
		{"analysis.thinningDraws", a.ThinningDraws.Label, a.ThinningDraws.Source},
		{"analysis.seed", a.Seed.Label, a.Seed.Source},
		{"analysis.minBlocked", a.MinBlocked.Label, a.MinBlocked.Source},
		{"analysis.ci", a.CI.Label, a.CI.Source},
		{"analysis.delta", a.Delta.Label, a.Delta.Source},
		{"decisionRule", s.DecisionRule.Label, s.DecisionRule.Source},
		{"reference", s.Reference.Label, s.Reference.Source},
	}
	for _, v := range labelled {
		if (v.label != "assumed" && v.label != "measured") || v.source == "" {
			return s, nil, fmt.Errorf("f316 spec: %s must be labelled assumed or measured, with a source", v.name)
		}
	}
	for _, v := range []float64{a.BlockDays.Value, a.BootstrapReps.Value, a.ThinningDraws.Value, a.MinBlocked.Value} {
		if v < 1 || v != math.Trunc(v) {
			return s, nil, fmt.Errorf("f316 spec: blockDays, bootstrapReps, thinningDraws and minBlocked must be whole numbers >= 1")
		}
	}
	var cats []category
	for _, c := range s.Categories.List {
		re, err := regexp.Compile("(?i)" + c.Regex)
		if err != nil {
			return s, nil, fmt.Errorf("f316 spec: category %s: %w", c.Name, err)
		}
		cats = append(cats, category{c.Name, re})
	}
	return s, cats, nil
}

var verdictHeader = []string{"instrument", "granularity", "time", "signal", "verdict", "reason", "filter_model"}

// Verdict is one stored filter verdict on a Supertrend flip.
type Verdict struct {
	Granularity string
	Time        time.Time // open of the flip bar
	Dir         int       // +1 buy, -1 sell
	Suppress    bool
	Reason      string
	Model       string // "unknown" when the signal has no snapshot row
}

// LoadVerdicts reads the verdict export and refuses it unless its header, instrument,
// times, sides and verdicts are the export's and its sha256 matches the manifest.
func LoadVerdicts(s F316Spec, r io.Reader) ([]Verdict, error) {
	const fix = "re-export the file or change the manifest in a reviewed commit"
	h := sha256.New()
	cr := csv.NewReader(io.TeeReader(r, h))
	rec, err := cr.Read()
	if err != nil || !slices.Equal(rec, verdictHeader) {
		return nil, fmt.Errorf("verdicts: header %v (%v), want %v; %s", rec, err, verdictHeader, fix)
	}
	var out []Verdict
	for {
		rec, err = cr.Read()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("verdicts: %w; %s", err, fix)
		}
		line, _ := cr.FieldPos(0)
		if rec[0] != s.Verdicts.Instrument {
			return nil, fmt.Errorf("verdicts line %d: instrument %s is not the manifest's %s; %s", line, rec[0], s.Verdicts.Instrument, fix)
		}
		t, err := time.Parse(time.RFC3339Nano, rec[2])
		if err != nil {
			return nil, fmt.Errorf("verdicts line %d: %w; %s", line, err, fix)
		}
		v := Verdict{Granularity: rec[1], Time: t, Dir: map[string]int{"buy": 1, "sell": -1}[rec[3]], Suppress: rec[4] == "suppress", Reason: rec[5], Model: rec[6]}
		if v.Dir == 0 {
			return nil, fmt.Errorf("verdicts line %d: signal %q is not buy or sell; %s", line, rec[3], fix)
		}
		if !v.Suppress && rec[4] != "alert" {
			return nil, fmt.Errorf("verdicts line %d: verdict %q is not alert or suppress; %s", line, rec[4], fix)
		}
		if v.Model == "" {
			v.Model = "unknown"
		}
		out = append(out, v)
	}
	if got := hex.EncodeToString(h.Sum(nil)); got != s.Verdicts.SHA256 {
		return nil, fmt.Errorf("verdicts: sha256 %s, manifest %s; %s", got, s.Verdicts.SHA256, fix)
	}
	if len(out) != s.Verdicts.Rows {
		return nil, fmt.Errorf("verdicts: %d rows, manifest %d; %s", len(out), s.Verdicts.Rows, fix)
	}
	return out, nil
}

var granSeconds = map[string]int{"M1": 60, "M5": 300, "M15": 900, "H1": 3600}

// Resample groups ascending bars into buckets that start at the floor of the bar time
// to sec seconds since the Unix epoch: first open, highest high, lowest low, last close.
func Resample(bars []backtest.Candle, sec int) []backtest.Candle {
	var out []backtest.Candle
	for _, b := range bars {
		start := time.Unix(b.Time.Unix()/int64(sec)*int64(sec), 0).UTC()
		if n := len(out); n > 0 && out[n-1].Time.Equal(start) {
			c := &out[n-1]
			c.High, c.Low, c.Close, c.Volume = max(c.High, b.High), min(c.Low, b.Low), b.Close, c.Volume+b.Volume
			continue
		}
		out = append(out, backtest.Candle{Time: start, Open: b.Open, High: b.High, Low: b.Low, Close: b.Close, Volume: b.Volume})
	}
	return out
}

// Scored is a verdict joined to its E0 trade.
type Scored struct {
	Verdict
	NetR float64
	Cats []string // matched categories of a suppression, or "other"; nil when allowed
}

// Exclusion reasons, in the order they are checked.
var exclusionReasons = []string{"fail_open", "unsupported_granularity", "unmatched", "censored"}

// Join scores each verdict with the E0 trade at its flip time and side, one E0 run per
// granularity, and counts every excluded verdict by reason.
func Join(e0 Spec, cats []category, bid, ask []backtest.Candle, vs []Verdict) ([]Scored, map[string]int) {
	excluded := map[string]int{}
	type key = [2]int64 // flip time in Unix nanoseconds, direction
	trades := map[string]map[key]Trade{}
	var out []Scored
	for _, v := range vs {
		sec, ok := granSeconds[v.Granularity]
		switch {
		case strings.HasPrefix(v.Reason, "filter error"):
			excluded["fail_open"]++
			continue
		case !ok:
			excluded["unsupported_granularity"]++
			continue
		}
		m, done := trades[v.Granularity]
		if !done {
			s := e0
			s.Feed.Granularity, s.Feed.BarSeconds = v.Granularity, sec
			b, a := bid, ask
			if sec != e0.Feed.BarSeconds {
				b, a = Resample(bid, sec), Resample(ask, sec)
			}
			m = map[key]Trade{}
			for _, tr := range Run(s, b, a).Trades {
				m[key{tr.Flip.UnixNano(), int64(tr.Dir)}] = tr
			}
			trades[v.Granularity] = m
		}
		tr, ok := m[key{v.Time.UnixNano(), int64(v.Dir)}]
		switch {
		case !ok:
			excluded["unmatched"]++
			continue
		case tr.Reason == "end":
			excluded["censored"]++
			continue
		}
		sc := Scored{Verdict: v, NetR: tr.NetR}
		if v.Suppress {
			sc.Cats = categorize(cats, v.Reason)
		}
		out = append(out, sc)
	}
	return out, excluded
}

// categorize returns every category whose regex matches the reason, or "other".
func categorize(cats []category, reason string) []string {
	var out []string
	for _, c := range cats {
		if c.re.MatchString(reason) {
			out = append(out, c.name)
		}
	}
	if out == nil {
		out = []string{"other"}
	}
	return out
}

// Interval is a point estimate with its bootstrap CI; OK is false when no replicate
// defines the statistic.
type Interval struct {
	Est, Lo, Hi float64
	OK          bool
}

type RuleResult struct {
	Name                       string
	Blocked                    int
	BlockedMean, KeptMean, All float64
	Delta                      Interval
	ThinningPct                float64
	Decision                   string
}

type MeanResult struct {
	Name string
	N    int
	Mean Interval
}

// percentile is numpy's default linear interpolation on a sorted copy.
func percentile(x []float64, p float64) float64 {
	s := slices.Clone(x)
	sort.Float64s(s)
	pos := p / 100 * float64(len(s)-1)
	lo := int(math.Floor(pos))
	if lo+1 >= len(s) {
		return s[len(s)-1]
	}
	return s[lo] + (s[lo+1]-s[lo])*(pos-float64(lo))
}

func interval(est float64, reps []float64) Interval {
	if len(reps) == 0 {
		return Interval{Est: est}
	}
	return Interval{Est: est, Lo: percentile(reps, 2.5), Hi: percentile(reps, 97.5), OK: true}
}

// Decide is the preregistered rule: keep when the rule blocks worse-than-average
// signals, drop when it blocks better-than-average ones, by the delta CI alone.
func Decide(blocked, minBlocked int, d Interval) string {
	switch {
	case blocked < minBlocked || !d.OK:
		return "insufficient evidence"
	case d.Hi < 0:
		return "keep"
	case d.Lo > 0:
		return "drop"
	}
	return "insufficient evidence"
}

// VersusAverage reads a blocked-minus-all CI by the preregistered late/chasing rule.
func VersusAverage(d Interval) string {
	switch {
	case d.OK && d.Lo > 0:
		return "better than average"
	case d.OK && d.Hi < 0:
		return "worse than average"
	}
	return "not distinguishable from average"
}

// Analysis holds every number the report prints.
type Analysis struct {
	Scored   []Scored
	Excluded map[string]int
	Days     int
	Means    []MeanResult // all, allowed, suppressed
	Rules    []RuleResult // all suppressions, each category, other
}

// Analyze bootstraps moving blocks of days and then draws the random thinnings, from
// one PCG stream seeded by the spec.
func Analyze(s F316Spec, cats []category, sc []Scored, excluded map[string]int) Analysis {
	a := Analysis{Scored: sc, Excluded: excluded}
	n := len(sc)
	var days []string
	rows := map[string][]int{}
	for i, x := range sc {
		d := x.Time.UTC().Format(time.DateOnly)
		if rows[d] == nil {
			days = append(days, d)
		}
		rows[d] = append(rows[d], i)
	}
	sort.Strings(days)
	a.Days = len(days)
	rng := rand.New(rand.NewPCG(uint64(s.Analysis.Seed.Value), uint64(s.Analysis.Seed.Value)))
	// each replicate is a list of row indices, days repeated as drawn
	var reps [][]int
	if nd := len(days); nd > 0 {
		blk := min(int(s.Analysis.BlockDays.Value), nd)
		for range int(s.Analysis.BootstrapReps.Value) {
			var idx []int
			for drawn := 0; drawn < nd; {
				start := rng.IntN(nd - blk + 1)
				for k := start; k < start+blk && drawn < nd; k++ {
					idx = append(idx, rows[days[k]]...)
					drawn++
				}
			}
			reps = append(reps, idx)
		}
	}
	// meanOf returns the mean net R and the count of the rows in idx that keep selects
	meanOf := func(idx []int, keep func(int) bool) (float64, int) {
		sum, c := 0.0, 0
		for _, i := range idx {
			if keep(i) {
				sum += sc[i].NetR
				c++
			}
		}
		return sum / float64(c), c
	}
	all := make([]int, n)
	for i := range all {
		all[i] = i
	}
	type group struct {
		name string
		sel  func(int) bool // a mean's rows, or a rule's blocked rows
	}
	everyRow := func(int) bool { return true }
	suppressed := func(i int) bool { return sc[i].Suppress }
	for _, g := range []group{{"all scored", everyRow}, {"allowed", func(i int) bool { return !sc[i].Suppress }}, {"suppressed", suppressed}} {
		est, c := meanOf(all, g.sel)
		var rs []float64
		for _, idx := range reps {
			if m, k := meanOf(idx, g.sel); k > 0 {
				rs = append(rs, m)
			}
		}
		a.Means = append(a.Means, MeanResult{g.name, c, interval(est, rs)})
	}
	rules := []group{{"all suppressions", suppressed}}
	for _, c := range slices.Concat(cats, []category{{name: "other"}}) {
		rules = append(rules, group{c.name, func(i int) bool { return slices.Contains(sc[i].Cats, c.name) }})
	}
	minBlocked := int(s.Analysis.MinBlocked.Value)
	perm := make([]int, n)
	allMean, _ := meanOf(all, everyRow)
	for _, r := range rules {
		res := RuleResult{Name: r.name, All: allMean}
		res.BlockedMean, res.Blocked = meanOf(all, r.sel)
		res.KeptMean, _ = meanOf(all, func(i int) bool { return !r.sel(i) })
		if res.Blocked > 0 {
			var rs []float64
			for _, idx := range reps {
				// a replicate with no blocked or no kept row leaves the delta undefined
				if b, nb := meanOf(idx, r.sel); nb > 0 && nb < len(idx) {
					m, _ := meanOf(idx, everyRow)
					rs = append(rs, b-m)
				}
			}
			res.Delta = interval(res.BlockedMean-res.All, rs)
			// random thinning: the same blocked count drawn uniformly without replacement
			below, draws := 0, int(s.Analysis.ThinningDraws.Value)
			for range draws {
				for i := range perm {
					perm[i] = i
				}
				sum := 0.0
				for k := range res.Blocked {
					j := k + rng.IntN(n-k)
					perm[k], perm[j] = perm[j], perm[k]
					sum += sc[perm[k]].NetR
				}
				if sum/float64(res.Blocked)-res.All < res.Delta.Est {
					below++
				}
			}
			res.ThinningPct = 100 * float64(below) / float64(draws)
		}
		res.Decision = Decide(res.Blocked, minBlocked, res.Delta)
		a.Rules = append(a.Rules, res)
	}
	return a
}

// F316Inputs are the raw bytes and readers of one run; Render prints their sha256.
type F316Inputs struct {
	F316JSON, E0JSON []byte
	Data, Verdicts   io.Reader
}

// RunF316 checks the E0 spec against the reference, loads both exports, scores the
// verdicts and returns the markdown report.
func RunF316(in F316Inputs) ([]byte, error) {
	s, cats, err := ParseF316Spec(in.F316JSON)
	if err != nil {
		return nil, err
	}
	e0sum := sha256.Sum256(in.E0JSON)
	if got := hex.EncodeToString(e0sum[:]); got != s.E0Spec.SHA256 {
		return nil, fmt.Errorf("e0 spec: sha256 %s, reference %s; restore %s or change the reference in a reviewed commit", got, s.E0Spec.SHA256, s.E0Spec.Path)
	}
	e0, err := ParseSpec(in.E0JSON)
	if err != nil {
		return nil, err
	}
	if e0.Instrument.Name != s.Verdicts.Instrument {
		return nil, fmt.Errorf("f316 spec: verdict instrument %s is not the E0 instrument %s", s.Verdicts.Instrument, e0.Instrument.Name)
	}
	bid, ask, err := Load(e0, in.Data)
	if err != nil {
		return nil, err
	}
	vs, err := LoadVerdicts(s, in.Verdicts)
	if err != nil {
		return nil, err
	}
	sc, excluded := Join(e0, cats, bid, ask, vs)
	a := Analyze(s, cats, sc, excluded)
	sum := sha256.Sum256(in.F316JSON)
	return render(s, e0, hex.EncodeToString(sum[:]), len(vs), a), nil
}

func ci(d Interval) string {
	if !d.OK {
		return fmt.Sprintf("%+.3f [n/a]", d.Est)
	}
	return fmt.Sprintf("%+.3f [%+.3f, %+.3f]", d.Est, d.Lo, d.Hi)
}

func meanOrNA(sum, n float64) string {
	if n == 0 {
		return "n/a"
	}
	return fmt.Sprintf("%+.3f", sum/n)
}

func render(s F316Spec, e0 Spec, specSum string, verdictRows int, a Analysis) []byte {
	var b strings.Builder
	p := func(format string, args ...any) { fmt.Fprintf(&b, format, args...) }
	p("# %s: live LLM filter verdicts scored under E0 (%s)\n\n", s.ID, s.Verdicts.Instrument)
	p("This report claims no edge and no profitable strategy. %s\n\n", s.Seen)
	p("Question: %s\n\n", s.Question)
	p("## Inputs\n\n| Item | Value |\n|---|---|\n")
	p("| F316 spec | `docs/research/experiments/f316/spec.json`, sha256 `%s` |\n", specSum)
	p("| E0 spec | `%s`, sha256 `%s` |\n", s.E0Spec.Path, s.E0Spec.SHA256)
	p("| Outcome export | `%s`, sha256 `%s`, %d rows |\n", e0.Dataset.Path, e0.Dataset.SHA256, e0.Dataset.Rows)
	p("| Verdict export | `%s`, sha256 `%s`, %d rows |\n\n", s.Verdicts.Path, s.Verdicts.SHA256, verdictRows)
	p("Both exports are one-time owner exports and are not committed. Every cost and timing value is the E0 value, labelled in the [E0 declared values](../e0/report.md#declared-values). Every F316 setting is labelled assumed or measured with a source in the F316 spec.\n\n")

	p("## Rules\n\nThe granularities, join, exclusions, reason categories, statistics and decision rule are preregistered in the [F316 spec](spec.json). For each granularity, the M1 bid and ask bars are resampled and `research.Run` replays E0 (Supertrend 10/3 on bid bars, %.1f ATR stop, %.0f R target, reversal, %d-bar time stop in bars of that granularity, %.0f ms decision delay, spread and financing). A suppressed signal is scored as if traded.\n\n",
		e0.Experiment.Strategy.StopATR, e0.Experiment.Strategy.RR, e0.Experiment.Strategy.MaxBars, e0.Experiment.Timing.DecisionDelayMs.Value)

	p("## Population\n\nScored: %d of %d verdicts, over %d UTC days.\n\n", len(a.Scored), verdictRows, a.Days)
	p("Excluded verdicts by reason. E0 holds every flip that arrives while a trade is open, so `unmatched` can be large.\n\n| Reason | Verdicts |\n|---|---|\n")
	for _, r := range exclusionReasons {
		p("| %s | %d |\n", r, a.Excluded[r])
	}

	p("\n## Allowed and suppressed\n\nMean net R per signal with its block-bootstrap CI.\n\n| Group | Signals | Mean net R [CI] |\n|---|---|---|\n")
	for _, m := range a.Means {
		if m.N == 0 {
			p("| %s | 0 | n/a |\n", m.Name)
			continue
		}
		p("| %s | %d | %s |\n", m.Name, m.N, ci(m.Mean))
	}

	p("\n## Blocking rules and recommendations\n\nDelta is the blocked mean minus the all mean, in net R. The random-thinning percentile is the share of %.0f random draws of the same blocked count whose delta is below the observed delta. The recommendation follows the preregistered decision rule. It describes the stored log under E0 rules only and is no evidence of a profitable strategy.\n\n", s.Analysis.ThinningDraws.Value)
	p("| Rule | Blocked | Share | Blocked mean | Kept mean | All mean | Delta [CI] | Random-thinning percentile | Recommendation |\n|---|---|---|---|---|---|---|---|---|\n")
	for _, r := range a.Rules {
		if r.Blocked == 0 {
			p("| %s | 0 | 0.0%% | n/a | n/a | n/a | n/a | n/a | %s |\n", r.Name, r.Decision)
			continue
		}
		// blocking every signal leaves no kept mean and makes every thinning the observed one
		kept, thin := "n/a", "n/a"
		if r.Blocked < len(a.Scored) {
			kept, thin = fmt.Sprintf("%+.3f", r.KeptMean), fmt.Sprintf("%.1f", r.ThinningPct)
		}
		p("| %s | %d | %.1f%% | %+.3f | %s | %+.3f | %s | %s | %s |\n", r.Name, r.Blocked, 100*float64(r.Blocked)/float64(len(a.Scored)), r.BlockedMean, kept, r.All, ci(r.Delta), thin, r.Decision)
	}

	p("\n## Late/chasing\n\n")
	for _, r := range a.Rules {
		if r.Name == "late_chasing" {
			p("By the preregistered rule (%s), late/chasing suppressions block signals that are %s: %d blocked, delta %s.\n", s.DecisionRule.LateChasing, VersusAverage(r.Delta), r.Blocked, ci(r.Delta))
		}
	}

	p("\n## By filter model\n\nCounts and mean net R without CIs. `unknown` is a signal without a snapshot row.\n\n| Model | Allowed | Allowed mean | Suppressed | Suppressed mean |\n|---|---|---|---|---|\n")
	models := map[string][4]float64{} // allowed count and sum, suppressed count and sum
	for _, x := range a.Scored {
		m, k := models[x.Model], 0
		if x.Suppress {
			k = 2
		}
		m[k]++
		m[k+1] += x.NetR
		models[x.Model] = m
	}
	for _, name := range slices.Sorted(maps.Keys(models)) {
		m := models[name]
		p("| %s | %.0f | %s | %.0f | %s |\n", name, m[0], meanOrNA(m[1], m[0]), m[2], meanOrNA(m[3], m[2]))
	}

	ref := s.Reference
	p("\n## filter316 reference\n\nSource: %s, labelled %s. These numbers describe a different management and a different population, so they are a reference and no target. %s\n\n", ref.Source, ref.Label, ref.Differences)
	for _, line := range ref.Summary {
		p("- %s\n", line)
	}
	if len(ref.Header) > 0 {
		p("\n| %s |\n|%s\n", strings.Join(ref.Header, " | "), strings.Repeat("---|", len(ref.Header)))
		for _, row := range ref.Rows {
			p("| %s |\n", strings.Join(row, " | "))
		}
	}

	p("\n## Limits\n\n")
	p("- The filter316 outcomes were seen before this spec was written, so this run is a reproduction and no independent test.\n")
	p("- One instrument, %s. The outcome export ends at %s.\n", s.Verdicts.Instrument, e0.Dataset.Last.Format(time.RFC3339))
	p("- No multiple-comparison correction across the rules.\n")
	p("- The filter316 drop rule also fired on a delta below the null q2.5 of its random thinning. This rule drops on the delta CI alone, so a filter316 drop can read here as insufficient evidence.\n")
	p("- The regexes run under Go RE2, where `\\b` and `\\d` are ASCII-only; filter316 ran them under Python `re`, where they also match non-ASCII word characters and digits.\n")
	p("- Rows rewritten by the refilter script cannot be told apart and are kept.\n")
	p("\n## Run\n\nFrom `platform/`:\n\n```\ngo run ./cmd/research-f316 --spec ../docs/research/experiments/f316/spec.json --out <report path>\n```\n")
	return []byte(b.String())
}
