package api

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/mfittko/market-signals/platform/internal/backtest"
)

// Auto grill: instead of asking the trader, the console backtests Supertrend flips
// on this instrument with a small grid of stop, target, ADX and volume settings,
// then the coach turns the evidence into a revised prompt. Settings are ranked on
// the first 70% of trades and judged on the last 30%. The backtest measures the
// flip rule family, not the prompt itself, and the response says so.

const autoGrillSystem = `You are a trading-strategy coach revising a strategy prompt from backtest evidence.
The evidence is a replay of Supertrend flips on one instrument and timeframe with candidate stop, target, ADX and volume settings. Results are in R, the multiples of the initial stop distance. Candidates are ranked on training trades and judged on later test trades. "holds" is true only when the test result beat the plain-flip baseline with enough test trades.
The backtest cannot replay the prompt itself, because a model judges the prompt. It only measures which filters and risk settings help flips on this data.
Reply with ONE JSON object and nothing else, no code fences:
{"findings":[{"issue":"<what the evidence shows>","fix":"<what to change>"}],
 "recommendation":"<one to three sentences: what to adopt and how sure the evidence is>",
 "prompt":"<the full revised strategy prompt>",
 "summary":"<one line of what changed>"}
Rules:
- Adopt a numeric setting only from a candidate with holds=true. If none holds, keep the numeric settings of the current prompt, say the evidence does not support a change, and improve only the wording: concrete thresholds, when to hold, what invalidates the idea.
- Always state the sample sizes and that the history covers a short period, so the result may not carry over to other market conditions.
- Never quote a number that is not in the evidence.
- Edit the existing prompt, do not rewrite it. Keep every section, rule and sentence that the evidence does not contradict, in its original wording and order. Change only the settings and wording the evidence supports, and add a short EVIDENCE section. The revised prompt is the full text, as long as the original needs.`

type autoCandidate struct {
	backtest.Candidate
	Holds bool `json:"holds"`
}

func (s *Server) autoGrill(w http.ResponseWriter, r *http.Request) {
	var b struct {
		Name        string `json:"name"`
		Instrument  string `json:"instrument"`
		Granularity string `json:"granularity"`
		Draft       string `json:"draft"`
	}
	if !decode(w, r, &b, 64<<10) {
		return
	}
	if b.Instrument == "" || b.Granularity == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "instrument and granularity are required"})
		return
	}
	if len(b.Draft) > maxPrompt {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": fmt.Sprintf("draft is over %d bytes", maxPrompt)})
		return
	}
	candles, flips, from, to, err := s.loadHistory(r.Context(), b.Instrument, b.Granularity)
	if err != nil {
		s.fail500(w, err)
		return
	}
	if len(candles) < 300 || len(flips) < 60 {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]any{"error": fmt.Sprintf(
			"not enough history for %s %s: %d candles and %d flips (need 300 and 60)", b.Instrument, b.Granularity, len(candles), len(flips))})
		return
	}
	rep := backtest.Search(candles, flips, 5)
	cands := make([]autoCandidate, len(rep.Candidates))
	for i, c := range rep.Candidates {
		cands[i] = autoCandidate{c, rep.Holds(c)}
	}
	out := map[string]any{"backtest": map[string]any{
		"instrument": b.Instrument, "granularity": b.Granularity, "from": from, "to": to,
		"candles": len(candles), "flips": rep.Flips, "tried": rep.Tried,
		"baseline": rep.Baseline, "candidates": cands,
		"caveats": []string{
			"It replays Supertrend flips, not your prompt. A model judges the prompt, so it cannot be replayed exactly.",
			fmt.Sprintf("The history is %d days, one market regime. Treat a gain as a lead, not proof.", int(to.Sub(from).Hours()/24)),
			fmt.Sprintf("%d settings were tried, so the best training result is partly luck. Trust the test columns.", rep.Tried),
		},
	}}
	if s.cfg.Complete != nil {
		msgs := []map[string]any{
			{"role": "system", "content": autoGrillSystem},
			{"role": "user", "content": s.grillContext(r.Context(), b.Name, "auto", b.Draft, "") + "\n" + evidenceText(b.Instrument, b.Granularity, from, to, rep, cands)},
		}
		if reply, err := s.cfg.Complete(r.Context(), msgs); err != nil {
			s.log.Error("autogrill", "err", err)
			out["coachError"] = "the coach call failed: " + err.Error()
		} else {
			out["turn"] = parseTurn(reply)
			out["reply"] = reply
		}
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) loadHistory(ctx context.Context, instrument, gran string) ([]backtest.Candle, []backtest.Flip, time.Time, time.Time, error) {
	var from, to time.Time
	rows, err := s.st.Pool.Query(ctx, `SELECT time, open, high, low, close, COALESCE(volume,0) FROM candles WHERE instrument=$1 AND granularity=$2 ORDER BY time`, instrument, gran)
	if err != nil {
		return nil, nil, from, to, err
	}
	defer rows.Close()
	var c []backtest.Candle
	for rows.Next() {
		var k backtest.Candle
		if err := rows.Scan(&k.Time, &k.Open, &k.High, &k.Low, &k.Close, &k.Volume); err != nil {
			return nil, nil, from, to, err
		}
		c = append(c, k)
	}
	if err := rows.Err(); err != nil {
		return nil, nil, from, to, err
	}
	if len(c) > 0 {
		from, to = c[0].Time, c[len(c)-1].Time
	}
	frows, err := s.st.Pool.Query(ctx, `SELECT time, signal FROM signals WHERE instrument=$1 AND granularity=$2 AND kind='supertrend-flip' ORDER BY time`, instrument, gran)
	if err != nil {
		return nil, nil, from, to, err
	}
	defer frows.Close()
	var f []backtest.Flip
	for frows.Next() {
		var t time.Time
		var sig string
		if err := frows.Scan(&t, &sig); err != nil {
			return nil, nil, from, to, err
		}
		if sig == "buy" {
			f = append(f, backtest.Flip{Time: t, Dir: 1})
		} else if sig == "sell" {
			f = append(f, backtest.Flip{Time: t, Dir: -1})
		}
	}
	return c, f, from, to, frows.Err()
}

func evidenceText(inst, gran string, from, to time.Time, rep backtest.Report, cands []autoCandidate) string {
	var sb strings.Builder
	fmt.Fprintf(&sb, "Backtest evidence for %s %s, %s to %s, %d flips, %d settings tried.\n", inst, gran, from.Format("2006-01-02"), to.Format("2006-01-02"), rep.Flips, rep.Tried)
	line := func(tag string, p backtest.Params, tr, te backtest.Stats, holds *bool) {
		fmt.Fprintf(&sb, "- %s stop=%.1fATR target=%.1fR minADX=%.0f minVolume=%.1f | train: %d trades, win %.0f%%, expectancy %.2fR, PF %.2f | test: %d trades, win %.0f%%, expectancy %.2fR, PF %.2f, maxDD %.1fR",
			tag, p.StopATR, p.RR, p.MinADX, p.MinVolume, tr.Trades, tr.WinRate*100, tr.Expectancy, tr.ProfitFac, te.Trades, te.WinRate*100, te.Expectancy, te.ProfitFac, te.MaxDD)
		if holds != nil {
			fmt.Fprintf(&sb, " | holds=%v", *holds)
		}
		sb.WriteString("\n")
	}
	line("baseline (plain flip)", rep.Baseline.Params, rep.Baseline.Train, rep.Baseline.Test, nil)
	for i, c := range cands {
		h := c.Holds
		line(fmt.Sprintf("candidate %d", i+1), c.Params, c.Train, c.Test, &h)
	}
	return sb.String()
}
