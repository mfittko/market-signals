package backtest

import "math"

// Supertrend returns the flips of Supertrend(period, mult) and the Wilder ATR of every
// bar. It ports computeSupertrend and detectFlips from scripts/supertrend.mjs: the ATR
// is seeded with the mean of the first period true ranges, the bands use the bar's
// high-low midpoint, and a flip is the bar whose close changes the trend. Every value
// at bar i reads only bars 0..i, so a later bar never changes an earlier flip.
func Supertrend(c []Candle, period int, mult float64) ([]Flip, []float64) {
	n := len(c)
	atr := make([]float64, n)
	if period < 1 || n < period+2 {
		return nil, atr
	}
	tr := make([]float64, n)
	for i := 1; i < n; i++ {
		h, l, pc := c[i].High, c[i].Low, c[i-1].Close
		tr[i] = math.Max(h-l, math.Max(math.Abs(h-pc), math.Abs(l-pc)))
	}
	var seed float64
	for i := 1; i <= period; i++ {
		seed += tr[i]
	}
	atr[period] = seed / float64(period)
	for i := period + 1; i < n; i++ {
		atr[i] = (atr[i-1]*float64(period-1) + tr[i]) / float64(period)
	}
	var flips []Flip
	prevUpper, prevLower := math.Inf(1), math.Inf(-1)
	up := true
	for i := period; i < n; i++ {
		mid := (c[i].High + c[i].Low) / 2
		bu, bl := mid+mult*atr[i], mid-mult*atr[i]
		pc := c[i-1].Close
		upper, lower := prevUpper, prevLower
		if bu < prevUpper || pc > prevUpper {
			upper = bu
		}
		if bl > prevLower || pc < prevLower {
			lower = bl
		}
		was := up
		if c[i].Close > upper {
			up = true
		} else if c[i].Close < lower {
			up = false
		}
		// the Node port has no trend before bar period, so the first flip can be at period+1
		if i > period && up != was {
			d := -1
			if up {
				d = 1
			}
			flips = append(flips, Flip{Time: c[i].Time, Dir: d})
		}
		prevUpper, prevLower = upper, lower
	}
	return flips, atr
}
