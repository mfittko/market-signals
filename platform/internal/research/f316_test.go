package research

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"maps"
	"math"
	"os"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/mfittko/market-signals/platform/internal/backtest"
)

const frozenF316 = "../../../docs/research/experiments/f316/spec.json"

func sha(b []byte) string {
	s := sha256.Sum256(b)
	return hex.EncodeToString(s[:])
}

func TestFrozenF316SpecMatchesThePreregistrationAndE0(t *testing.T) {
	b, err := os.ReadFile(frozenF316)
	if err != nil {
		t.Fatal(err)
	}
	s, cats, err := ParseF316Spec(b)
	if err != nil {
		t.Fatal(err)
	}
	var prereg struct {
		Taxonomy struct {
			Categories map[string]string `json:"categories"`
		} `json:"taxonomy"`
	}
	p, err := os.ReadFile("../../../docs/research/registry/campaigns/filter316/prereg.json")
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(p, &prereg); err != nil {
		t.Fatal(err)
	}
	want := prereg.Taxonomy.Categories
	if len(s.Categories.List) != len(want) || len(cats) != len(want) {
		t.Fatalf("spec has %d categories, prereg %d", len(s.Categories.List), len(want))
	}
	for _, c := range s.Categories.List {
		if want[c.Name] != c.Regex {
			t.Errorf("category %s: regex differs from the filter316 prereg", c.Name)
		}
	}
	e0, err := os.ReadFile("../../../" + s.E0Spec.Path)
	if err != nil {
		t.Fatal(err)
	}
	if sha(e0) != s.E0Spec.SHA256 {
		t.Fatalf("e0 spec sha256 is not the reference %s", s.E0Spec.SHA256)
	}
}

// f316Spec is the frozen spec pointed at the E0 and verdict fixtures, with fewer
// replicates and one-day blocks so the two-day fixture bootstrap varies.
func f316Spec(t *testing.T, verdicts []byte) (F316Spec, []byte) {
	t.Helper()
	b, err := os.ReadFile(frozenF316)
	if err != nil {
		t.Fatal(err)
	}
	s, _, err := ParseF316Spec(b)
	if err != nil {
		t.Fatal(err)
	}
	e0JSON, _ := fixture(t)
	s.E0Spec.Path, s.E0Spec.SHA256 = "platform/internal/research/testdata/spec.json", sha(e0JSON)
	s.Verdicts.Path, s.Verdicts.SHA256, s.Verdicts.Rows = "platform/internal/research/testdata/verdicts.csv", sha(verdicts), 11
	s.Verdicts.First, s.Verdicts.Last = time.Date(2024, 3, 8, 19, 36, 0, 0, time.UTC), time.Date(2024, 3, 9, 6, 55, 0, 0, time.UTC)
	s.Analysis.BlockDays.Value, s.Analysis.BootstrapReps.Value, s.Analysis.ThinningDraws.Value = 1, 50, 20
	out, err := json.Marshal(s)
	if err != nil {
		t.Fatal(err)
	}
	return s, out
}

func verdictFixture(t *testing.T) []byte {
	t.Helper()
	b, err := os.ReadFile("testdata/verdicts.csv")
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestLoadVerdictsRefusesABadExport(t *testing.T) {
	good := verdictFixture(t)
	s, _ := f316Spec(t, good)
	if vs, err := LoadVerdicts(s, bytes.NewReader(good)); err != nil || len(vs) != 11 {
		t.Fatalf("good fixture: %d verdicts, %v", len(vs), err)
	}
	wrongSum := s
	wrongSum.Verdicts.SHA256 = strings.Repeat("0", 64)
	wrongRows := s
	wrongRows.Verdicts.Rows = 10
	wrongFirst := s
	wrongFirst.Verdicts.First = s.Verdicts.First.Add(-time.Minute)
	wrongLast := s
	wrongLast.Verdicts.Last = time.Date(2024, 3, 9, 23, 59, 0, 0, time.UTC)
	edit := func(from, to string) []byte {
		b := bytes.Replace(good, []byte(from), []byte(to), 1)
		if bytes.Equal(b, good) {
			t.Fatalf("edit %q did not change the fixture", from)
		}
		return b
	}
	for _, c := range []struct {
		name, want string
		spec       F316Spec
		data       []byte
	}{
		{"wrong header", "header", s, edit("filter_model", "model")},
		{"sha256 mismatch", "sha256", wrongSum, good},
		{"row count mismatch", "11 rows, manifest 10", wrongRows, good},
		{"bare quote", "bare \"", s, edit("WTICO/USD,M1,2024-03-08T19:36", "WTI\"CO/USD,M1,2024-03-08T19:36")},
		{"foreign instrument", "instrument XAU/USD", s, edit("WTICO/USD,M1,2024-03-08T19:36", "XAU/USD,M1,2024-03-08T19:36")},
		{"unparsable time", "parsing time", s, edit("2024-03-08T19:36:00.000000000Z", "2024-03-08 19:36")},
		{"unknown side", "not buy or sell", s, edit(",sell,alert,Clean", ",short,alert,Clean")},
		{"unknown verdict", "not alert or suppress", s, edit(",sell,alert,Clean", ",sell,unfiltered,Clean")},
		{"wrong first time", "manifest first 2024-03-08T19:35:00Z", wrongFirst, good},
		{"wrong last time", "last 2024-03-09T23:59:00Z", wrongLast, good},
		{"model with a pipe", "filter_model", s, edit(",model-a\n", ",model|x\n")},
		{"model with a newline", "filter_model", s, edit(",model-a\n", ",\"model\nx\"\n")},
		{"model with a carriage return", "filter_model", s, edit(",model-a\n", ",\"model\rx\"\n")},
		{"model with markup", "filter_model", s, edit(",model-a\n", ",<b>model</b>\n")},
	} {
		_, err := LoadVerdicts(c.spec, bytes.NewReader(c.data))
		if err == nil || !strings.Contains(err.Error(), c.want) || !strings.Contains(err.Error(), "re-export the file or change the manifest in a reviewed commit") {
			t.Errorf("%s: want a refusal naming %q and the recovery, got %v", c.name, c.want, err)
		}
	}
	for model, want := range map[string]string{"gpt-4o-mini": "gpt-4o-mini", "glm-4.6": "glm-4.6", "": "unknown"} {
		data := edit(",model-a\n", ","+model+"\n")
		ok := s
		ok.Verdicts.SHA256 = sha(data)
		vs, err := LoadVerdicts(ok, bytes.NewReader(data))
		if err != nil || vs[0].Model != want {
			t.Errorf("filter_model %q: want %q loaded, got %v", model, want, err)
		}
	}
}

func TestResampleBucketsByTheFloorOfTheBarTime(t *testing.T) {
	var m1 []backtest.Candle
	start := time.Date(2024, 3, 8, 10, 3, 0, 0, time.UTC)
	for k := range 10 {
		if k == 4 {
			continue // a missing minute inside the 10:05 bucket
		}
		f := float64(k)
		m1 = append(m1, backtest.Candle{Time: start.Add(time.Duration(k) * time.Minute), Open: 80 + f, High: 81 + f + float64(k%3), Low: 79 - f, Close: 80.5 + f, Volume: 1})
	}
	want := []backtest.Candle{
		{Time: time.Date(2024, 3, 8, 10, 0, 0, 0, time.UTC), Open: 80, High: 83, Low: 78, Close: 81.5, Volume: 2},
		{Time: time.Date(2024, 3, 8, 10, 5, 0, 0, time.UTC), Open: 82, High: 88, Low: 73, Close: 86.5, Volume: 4},
		{Time: time.Date(2024, 3, 8, 10, 10, 0, 0, time.UTC), Open: 87, High: 91, Low: 70, Close: 89.5, Volume: 3},
	}
	if got := Resample(m1, 300); !slices.Equal(got, want) {
		t.Fatalf("M5:\n got %+v\nwant %+v", got, want)
	}
	for sec, starts := range map[int][]time.Time{
		900:  {time.Date(2024, 3, 8, 10, 0, 0, 0, time.UTC)},
		3600: {time.Date(2024, 3, 8, 10, 0, 0, 0, time.UTC)},
	} {
		got := Resample(m1, sec)
		if len(got) != len(starts) || !got[0].Time.Equal(starts[0]) || got[0].Open != 80 || got[0].Close != 89.5 || got[0].High != 91 || got[0].Low != 70 {
			t.Errorf("%d s: got %+v", sec, got)
		}
	}
}

func TestJoinScoresOneTradePerVerdictAndCountsExclusions(t *testing.T) {
	e0, bid, ask := load(t)
	good := verdictFixture(t)
	s, specJSON := f316Spec(t, good)
	_, cats, err := ParseF316Spec(specJSON)
	if err != nil {
		t.Fatal(err)
	}
	vs, err := LoadVerdicts(s, bytes.NewReader(good))
	if err != nil {
		t.Fatal(err)
	}
	// cut the data two bars after the last M1 entry, so that trade ends at the data end
	cut := 0
	for cut < len(bid) && bid[cut].Time.Before(time.Date(2024, 3, 9, 6, 58, 0, 0, time.UTC)) {
		cut++
	}
	sc, excluded := Join(e0, cats, bid[:cut], ask[:cut], vs)
	if want := map[string]int{"fail_open": 1, "unsupported_granularity": 1, "unmatched": 3, "censored": 1}; !maps.Equal(excluded, want) {
		t.Fatalf("excluded %v, want %v", excluded, want)
	}
	runs := map[string]Artifact{}
	for g, sec := range map[string]int{"M1": 60, "M5": 300} {
		es := e0
		es.Feed.Granularity, es.Feed.BarSeconds = g, sec
		b, a := bid[:cut], ask[:cut]
		if sec != 60 {
			b, a = Resample(b, sec), Resample(a, sec)
		}
		runs[g] = Run(es, b, a)
	}
	wantCats := map[string][]string{
		"19:36": nil,
		"20:18": {"late_chasing", "low_volume"},
		"20:59": {"against_trend"},
		"21:56": {"other"},
		"21:15": {"late_chasing"},
	}
	if len(sc) != len(wantCats) {
		t.Fatalf("scored %d verdicts, want %d", len(sc), len(wantCats))
	}
	for _, x := range sc {
		hm := x.Time.Format("15:04")
		if !slices.Equal(x.Cats, wantCats[hm]) {
			t.Errorf("%s: categories %v, want %v", hm, x.Cats, wantCats[hm])
		}
		n := 0
		for _, tr := range runs[x.Granularity].Trades {
			if tr.Flip.Equal(x.Time) && tr.Dir == x.Dir {
				n++
				if tr.NetR != x.NetR || tr.Reason == "end" {
					t.Errorf("%s: net R %v from a %s trade, want %v", hm, x.NetR, tr.Reason, tr.NetR)
				}
			}
		}
		if n != 1 {
			t.Errorf("%s %s: %d E0 trades at the flip and side, want exactly 1", x.Granularity, hm, n)
		}
	}
	if sc[2].Model != "unknown" {
		t.Errorf("empty filter_model loaded as %q, want unknown", sc[2].Model)
	}
}

func TestCategoriesAreMultiLabelWithOtherAsTheFallback(t *testing.T) {
	b, err := os.ReadFile(frozenF316)
	if err != nil {
		t.Fatal(err)
	}
	_, cats, err := ParseF316Spec(b)
	if err != nil {
		t.Fatal(err)
	}
	for reason, want := range map[string][]string{
		"LATE chase into the day high":                   {"late_chasing"},
		"Volume 0.6× average, counter to HTF":            {"against_trend", "low_volume"},
		"RSI overbought, chop, EIA release":              {"late_chasing", "chop_weak_setup", "news_event"},
		"Momentum fine, trader note says wait":           {"other"},
		"lately the tape moved":                          {"other"}, // \blate\b needs a word boundary
		"3rd flip in an hour near the session top; thin": {"late_chasing", "low_volume", "chop_weak_setup"},
	} {
		if got := categorize(cats, reason); !slices.Equal(got, want) {
			t.Errorf("%q: %v, want %v", reason, got, want)
		}
	}
}

func TestDecisionRuleReadsTheDeltaCIAlone(t *testing.T) {
	for _, c := range []struct {
		blocked int
		d       Interval
		want    string
		vs      string
	}{
		{30, Interval{Est: -0.1, Lo: -0.2, Hi: -0.01, OK: true}, "keep", "worse than average"},
		{30, Interval{Est: 0.1, Lo: 0.01, Hi: 0.2, OK: true}, "drop", "better than average"},
		{30, Interval{Est: 0, Lo: -0.1, Hi: 0.1, OK: true}, "insufficient evidence", "not distinguishable from average"},
		{29, Interval{Est: -0.1, Lo: -0.2, Hi: -0.01, OK: true}, "insufficient evidence", "worse than average"},
		{30, Interval{Est: -0.1}, "insufficient evidence", "not distinguishable from average"},
	} {
		if got := Decide(c.blocked, 30, c.d); got != c.want {
			t.Errorf("%d %+v: %s, want %s", c.blocked, c.d, got, c.want)
		}
		if got := VersusAverage(c.d); got != c.vs {
			t.Errorf("%+v: %s, want %s", c.d, got, c.vs)
		}
	}
}

func TestAnalyzeDropsARuleThatBlocksBetterThanAverageSignals(t *testing.T) {
	var s F316Spec
	s.Analysis.BlockDays.Value, s.Analysis.BootstrapReps.Value, s.Analysis.ThinningDraws.Value = 1, 50, 200
	s.Analysis.Seed.Value, s.Analysis.MinBlocked.Value = 316, 4
	// every day: one suppressed winner and three allowed losers, so every replicate has the same delta
	var sc []Scored
	for d := range 4 {
		day := time.Date(2024, 3, 4+d, 12, 0, 0, 0, time.UTC)
		sc = append(sc, Scored{Verdict: Verdict{Time: day, Suppress: true}, NetR: 1, Cats: []string{"other"}})
		for k := range 3 {
			sc = append(sc, Scored{Verdict: Verdict{Time: day.Add(time.Duration(k+1) * time.Minute)}, NetR: -1})
		}
	}
	r := Analyze(s, nil, sc, map[string]int{}).Rules[0]
	if r.Name != "all suppressions" || r.Blocked != 4 || r.BlockedMean != 1 || r.All != -0.5 {
		t.Fatalf("rule %+v, want all suppressions blocking 4 rows of mean 1 against an all mean of -0.5", r)
	}
	if want := r.BlockedMean - r.All; r.Delta.Est != want || want <= 0 {
		t.Errorf("delta %v, want blocked mean minus all mean %v", r.Delta.Est, want)
	}
	if !r.Delta.OK || r.Delta.Lo != 1.5 || r.Delta.Hi != 1.5 {
		t.Errorf("delta CI %+v, want [1.5, 1.5]", r.Delta)
	}
	if r.Decision != "drop" {
		t.Errorf("decision %s, want drop", r.Decision)
	}
	// a random thinning of 4 of 16 rows beats the blocked winners only when it draws all four
	if r.ThinningPct < 95 {
		t.Errorf("thinning percentile %v, want near 100", r.ThinningPct)
	}
}

func TestPercentileInterpolatesLinearly(t *testing.T) {
	x := []float64{4, 1, 3, 2}
	for p, want := range map[float64]float64{2.5: 1.075, 97.5: 3.925, 50: 2.5, 100: 4} {
		if got := percentile(x, p); math.Abs(got-want) > 1e-12 {
			t.Errorf("p%v: %v, want %v", p, got, want)
		}
	}
}

func TestParseF316SpecRefusesAnUnlabelledValueAndABadRegex(t *testing.T) {
	b, err := os.ReadFile(frozenF316)
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range []struct{ from, to, want string }{
		{`"label": "assumed"`, `"label": "guessed"`, "assumed or measured"},
		{`"value": 1000`, `"value": 0`, "whole numbers"},
		{"\"blockDays\": {\n      \"value\": 5", "\"blockDays\": {\n      \"value\": 1.5", "whole numbers >= 1"},
		{"\"seed\": {\n      \"value\": 316", "\"seed\": {\n      \"value\": -1", "analysis.seed"},
		{"\"seed\": {\n      \"value\": 316", "\"seed\": {\n      \"value\": 316.5", "analysis.seed"},
		{`"regex": "counter|`, `"regex": "(counter|`, "against_trend"},
	} {
		changed := bytes.Replace(b, []byte(c.from), []byte(c.to), 1)
		if bytes.Equal(changed, b) {
			t.Fatalf("edit %q did not change the spec", c.from)
		}
		if _, _, err := ParseF316Spec(changed); err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%s: want a refusal naming %q, got %v", c.to, c.want, err)
		}
	}
}

func f316Inputs(t *testing.T) F316Inputs {
	t.Helper()
	verdicts := verdictFixture(t)
	_, specJSON := f316Spec(t, verdicts)
	e0JSON, data := fixture(t)
	return F316Inputs{F316JSON: specJSON, E0JSON: e0JSON, Data: bytes.NewReader(data), Verdicts: bytes.NewReader(verdicts)}
}

func TestRunF316RefusesAChangedE0Spec(t *testing.T) {
	in := f316Inputs(t)
	in.E0JSON = append(slices.Clone(in.E0JSON), ' ')
	if _, err := RunF316(in); err == nil || !strings.Contains(err.Error(), "change the reference in a reviewed commit") {
		t.Fatalf("want an e0 sha256 refusal, got %v", err)
	}
}

func TestRunF316RefusesAVerdictInstrumentOtherThanE0s(t *testing.T) {
	in := f316Inputs(t)
	s, _ := f316Spec(t, verdictFixture(t))
	s.Verdicts.Instrument = "XAU/USD"
	b, err := json.Marshal(s)
	if err != nil {
		t.Fatal(err)
	}
	in.F316JSON = b
	if _, err := RunF316(in); err == nil || !strings.Contains(err.Error(), "is not the E0 instrument WTICO/USD") {
		t.Fatalf("want an E0 instrument refusal, got %v", err)
	}
}

func TestRenderPrintsNAWhenARuleBlocksEveryScoredSignal(t *testing.T) {
	e0, _, _ := load(t)
	s, _ := f316Spec(t, verdictFixture(t))
	sc := []Scored{
		{Verdict: Verdict{Suppress: true, Model: "m"}, NetR: 1, Cats: []string{"other"}},
		{Verdict: Verdict{Suppress: true, Model: "m"}, NetR: -1, Cats: []string{"other"}},
	}
	r := string(render(s, e0, "sum", 2, Analyze(s, nil, sc, map[string]int{})))
	for _, rule := range []string{"all suppressions", "other"} {
		if want := "| " + rule + " | 2 | 100.0% | +0.000 | n/a | +0.000 | +0.000 [n/a] | n/a | insufficient evidence |"; !strings.Contains(r, want) {
			t.Errorf("report lacks %q", want)
		}
	}
	if strings.Contains(r, "NaN") {
		t.Error("report prints NaN")
	}
}

func TestRunF316ReportIsByteIdenticalAndCarriesEveryTable(t *testing.T) {
	var reports [2][]byte
	for k := range reports {
		r, err := RunF316(f316Inputs(t))
		if err != nil {
			t.Fatal(err)
		}
		reports[k] = r
	}
	if !bytes.Equal(reports[0], reports[1]) {
		t.Fatal("two runs on the same inputs give different report bytes")
	}
	r := string(reports[0])
	in := f316Inputs(t)
	for _, want := range []string{
		"claims no edge",
		"sha256 `" + sha(in.F316JSON) + "`",
		"| fail_open | 1 |\n| unsupported_granularity | 1 |\n| unmatched | 3 |\n| censored | 0 |",
		"Scored: 6 of 11 verdicts",
		"## Blocking rules and recommendations",
		"| Random-thinning percentile | Recommendation |",
		"| allowed | 2 | ",
		"| suppressed | 4 | ",
		"| all suppressions | 4 | 66.7% |",
		"| late_chasing | 2 | 33.3% |",
		"| news_event | 0 | 0.0% |",
		"| other | 1 | 16.7% |",
		"## Late/chasing\n\nBy the preregistered rule",
		"insufficient evidence", // two blocked late_chasing signals stay below minBlocked
		"| model-a | 2 | ",
		"| unknown | 0 | n/a | 1 | ",
		"## filter316 reference",
		"| late_chasing | 50% | +0.024 [-0.013, +0.058] | 9th | insufficient evidence |",
		"cannot confirm it independently",
		"Supertrend 10/3 on bid bars",
		"so they serve only as a reference.",
		"makes no claim about profitability.",
	} {
		if !strings.Contains(r, want) {
			t.Errorf("report lacks %q", want)
		}
	}
	// the delta of the overall rule has a bootstrap CI and a thinning percentile
	for _, line := range strings.Split(r, "\n") {
		if strings.HasPrefix(line, "| all suppressions | 4 | 66.7% |") && (strings.Contains(line, "[n/a]") || strings.Count(line, "|") != 10) {
			t.Errorf("overall rule row lacks a CI or a column: %s", line)
		}
	}
}
