package domain

import "testing"

func TestPredictionGranularity(t *testing.T) {
	for _, g := range []string{"M1", "M5", "M15", "M30", "H1", "H4"} {
		if !PredictionGranularity(g) {
			t.Errorf("%s should be a prediction granularity", g)
		}
		if _, err := GranularityDuration(g); err != nil {
			t.Errorf("%s: %v", g, err)
		}
	}
	for _, g := range []string{"M10", "M2", "H2", "D", ""} {
		if PredictionGranularity(g) {
			t.Errorf("%s should not be a prediction granularity", g)
		}
	}
}
