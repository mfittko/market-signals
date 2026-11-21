package strategy

import (
	"errors"
	"strings"
	"testing"
)

// Both specs are EXAMPLE_SPECS in scripts/strategy-spec.mjs.
const conservativeTrend = `{"schema_version":1,"entry":{"minAxesAligned":3,"require":{"trendStrength":["trending"],"direction":["aligned"]},"enforceExhaustionVeto":true},"exit":{"stopAtr":1.5,"targetAtr":3,"timeStopBars":36},"risk":{"riskPct":1}}`
const impulseScalp = `{"schema_version":1,"entry":{"minAxesAligned":2,"require":{"impulse":["impulsive"]},"enforceExhaustionVeto":true},"exit":{"stopAtr":1,"targetAtr":1.5,"timeStopBars":12},"risk":{"riskPct":0.5}}`

func TestValidateSpecAcceptsTheExampleSpecs(t *testing.T) {
	for _, s := range []string{conservativeTrend, impulseScalp,
		`{"schema_version":1,"entry":{"minAxesAligned":5,"require":{"exhaustion":"clear"}},"exit":{"stopAtr":2,"targetAtr":null}}`} {
		if err := ValidateSpec([]byte(s)); err != nil {
			t.Fatalf("%s: %v", s, err)
		}
	}
}

func TestScanStringsAcceptsPlainStringsAndRejectsNUL(t *testing.T) {
	for s, bad := range map[string]bool{"bull": false, "a b": false, "\u0000": true, "a\u0000b": true} {
		var errs []string
		scanStrings(map[string]any{"k": s}, "spec", func(f string, a ...any) { errs = append(errs, f) })
		if (len(errs) > 0) != bad {
			t.Errorf("%q: errors %v, want rejected=%v", s, errs, bad)
		}
	}
}

func TestValidateSpecRejectsEachRuleNamingTheField(t *testing.T) {
	for _, c := range []struct{ spec, want string }{
		{`{"schema_version":1,"entry":{"minAxesAligned":1},"exit":{"stopAtr":1},"name":"x"}`, "spec.name: unknown field"},
		{`{"schema_version":1,"entry":{"minAxesAligned":1,"minAxes":2},"exit":{"stopAtr":1}}`, "spec.entry.minAxes: unknown field"},
		{`{"schema_version":1,"entry":{"minAxesAligned":1},"exit":{"stopAtr":1,"stopATR":2}}`, "spec.exit.stopATR: unknown field"},
		{`{"schema_version":1,"entry":{"minAxesAligned":1},"exit":{"stopAtr":1},"risk":{"riskPct":1,"maxLoss":2}}`, "spec.risk.maxLoss: unknown field"},
		{`[]`, "spec must be an object"},
		{`null`, "spec must be an object"},
		{`{"schema_version":2,"entry":{"minAxesAligned":1},"exit":{"stopAtr":1}}`, "schema_version must be 1"},
		{`{"schema_version":1,"exit":{"stopAtr":1}}`, "entry required"},
		{`{"schema_version":1,"entry":{"minAxesAligned":6},"exit":{"stopAtr":1}}`, "entry.minAxesAligned must be an integer 1-5"},
		{`{"schema_version":1,"entry":{"minAxesAligned":1.5},"exit":{"stopAtr":1}}`, "entry.minAxesAligned must be an integer 1-5"},
		{`{"schema_version":1,"entry":{"minAxesAligned":1,"require":[]},"exit":{"stopAtr":1}}`, "entry.require must be an object"},
		{`{"schema_version":1,"entry":{"minAxesAligned":1,"require":{"mood":"good"}},"exit":{"stopAtr":1}}`, "entry.require.mood: unknown axis"},
		{`{"schema_version":1,"entry":{"minAxesAligned":1,"require":{"impulse":["fast"]}},"exit":{"stopAtr":1}}`, "entry.require.impulse: 'fast' is not a valid impulse verdict"},
		{`{"schema_version":1,"entry":{"minAxesAligned":1,"enforceExhaustionVeto":null},"exit":{"stopAtr":1}}`, "entry.enforceExhaustionVeto must be boolean"},
		{`{"schema_version":1,"entry":{"minAxesAligned":1}}`, "exit required"},
		{`{"schema_version":1,"entry":{"minAxesAligned":1},"exit":{"stopAtr":"2"}}`, "exit.stopAtr must be a positive number"},
		{`{"schema_version":1,"entry":{"minAxesAligned":1},"exit":{"stopAtr":1,"targetAtr":0}}`, "exit.targetAtr must be a positive number when set"},
		{`{"schema_version":1,"entry":{"minAxesAligned":1},"exit":{"stopAtr":1,"timeStopBars":0.5}}`, "exit.timeStopBars must be a positive integer when set"},
		{`{"schema_version":1,"entry":{"minAxesAligned":1},"exit":{"stopAtr":1},"risk":{"riskPct":101}}`, "risk.riskPct must be a number in (0,100]"},
		{`{"schema_version":1,"entry":{"minAxesAligned":1},"exit":{"stopAtr":1},"risk":3}`, "risk must be an object"},
		{`{"schema_version":1,"entry":{"minAxesAligned":1,"require":{"impulse":"2026-01-05"}},"exit":{"stopAtr":1}}`, "spec.entry.require.impulse: raw dates are forbidden"},
		{`{"schema_version":1,"entry":{"minAxesAligned":1},"exit":{"stopAtr":1},"EUR/USD":1}`, "spec.<key>: instrument symbols are forbidden"},
		{`{"schema_version":1,"entry":{"minAxesAligned":1,"require":{"impulse":"\u0000"}},"exit":{"stopAtr":1}}`, "spec.entry.require.impulse: a NUL character is not allowed"},
		{`{"schema_version":1,"entry":{"minAxesAligned":1,"require":{"impulse":"a\u0000b"}},"exit":{"stopAtr":1}}`, "spec.entry.require.impulse: a NUL character is not allowed"},
		{`{"schema_version":1,"entry":{"minAxesAligned":1},"exit":{"stopAtr":1},"a\u0000b":1}`, "spec.<key>: a NUL character is not allowed"},
	} {
		err := ValidateSpec([]byte(c.spec))
		if !errors.Is(err, ErrInvalidSpec) || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%s: got %v, want %q", c.spec, err, c.want)
		}
	}
}
