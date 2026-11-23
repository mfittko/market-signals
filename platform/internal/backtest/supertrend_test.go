package backtest

import (
	"reflect"
	"testing"
	"time"
)

// vee falls for n bars and then rises for n bars, one point per bar.
func vee(n int) []Candle {
	var c []Candle
	t0 := time.Date(2024, 1, 2, 0, 0, 0, 0, time.UTC)
	for i := 0; i < 2*n; i++ {
		p := float64(100 - i)
		if i >= n {
			p = float64(100 - 2*n + i)
		}
		c = append(c, Candle{Time: t0.Add(time.Duration(i) * time.Minute), Open: p, High: p + 0.5, Low: p - 0.5, Close: p})
	}
	return c
}

func TestSupertrendFlipsOnTheTurn(t *testing.T) {
	c := vee(40)
	flips, atr := Supertrend(c, 10, 3)
	// the trend starts up, so the fall gives one sell and the rise one buy, in that order
	if len(flips) != 2 || flips[0].Dir != -1 || flips[1].Dir != 1 {
		t.Fatalf("flips = %+v, want one sell then one buy", flips)
	}
	if !flips[1].Time.After(c[40].Time) {
		t.Fatalf("buy at %s, want after the low at %s", flips[1].Time, c[40].Time)
	}
	if atr[9] != 0 || atr[10] <= 0 {
		t.Fatalf("atr seeds at bar 10, got atr[9]=%v atr[10]=%v", atr[9], atr[10])
	}
}

func TestSupertrendReadsNoLaterBar(t *testing.T) {
	c := vee(40)
	all, _ := Supertrend(c, 10, 3)
	prefix, _ := Supertrend(c[:50], 10, 3)
	var early []Flip
	for _, f := range all {
		if f.Time.Before(c[50].Time) {
			early = append(early, f)
		}
	}
	if !reflect.DeepEqual(early, prefix) {
		t.Fatalf("flips before bar 50 differ: %+v vs %+v", early, prefix)
	}
}
