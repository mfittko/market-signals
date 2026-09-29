package api

import (
	"context"
	"fmt"
	"net/http"
	"strings"
)

// Grill mode: a coach interviews the trader about one strategy, one question at a
// time, grounded in that strategy's paper-trade record, and proposes a revised
// prompt in a fenced block. The console applies the block to its editor. Nothing
// is saved until the trader saves a new version.

const grillSystem = `You are a trading-strategy coach. The trader keeps strategies as short prompts. An automated analyst reads a strategy prompt together with a frozen market snapshot and proposes an entry or a hold. The analyst sees: an axis gate (trend strength ADX, direction, impulse, location, exhaustion), ATR, EMA 20/50/200, Bollinger position, RSI, VWAP distance, volume ratio, 20-bar extremes, higher-timeframe trends, the Supertrend flip and its age, standing rules and news headlines.
Your job is to sharpen the strategy by questioning it. Rules:
- Ask exactly ONE question per reply, and keep it short. Ground it in the supplied trade record or a gap in the prompt: vague words, missing numbers, unstated stops or targets, no hold condition, conflicting rules, rules the analyst cannot see.
- Prefer questions the trader can answer in a sentence. Offer two or three concrete options when helpful.
- Use only the numbers in the supplied record. Never invent performance figures.
- After each answer, say in one line what you will change. When the trader asks to see it, or after about five answers, output the full revised strategy prompt inside one fenced block that starts with three backticks and the word prompt, then a one-line summary of what changed.
- A good prompt is concrete: numeric thresholds, stops sized in ATR, when to hold, what invalidates the idea. It stays under 3000 characters and uses plain imperative sentences.
- Stay on strategy. Do not give financial advice. This is a paper-trading research tool.`

type chatMsg struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

func (s *Server) grill(w http.ResponseWriter, r *http.Request) {
	if s.cfg.Complete == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"error": "no model is configured for the console; the LLM key is read from the engine settings when the stack starts"})
		return
	}
	var b struct {
		Name     string    `json:"name"`
		Mode     string    `json:"mode"` // refine | create
		Draft    string    `json:"draft"`
		Brief    string    `json:"brief"` // wizard answers for a strategy that has no history yet
		Messages []chatMsg `json:"messages"`
	}
	if !decode(w, r, &b, 256<<10) {
		return
	}
	if len(b.Messages) == 0 || len(b.Messages) > 30 || len(b.Draft) > maxPrompt || len(b.Brief) > 8<<10 {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "messages are required (up to 30), draft up to 32 KB"})
		return
	}
	msgs := []map[string]any{{"role": "system", "content": grillSystem}}
	msgs = append(msgs, map[string]any{"role": "system", "content": s.grillContext(r.Context(), b.Name, b.Mode, b.Draft, b.Brief)})
	for i, m := range b.Messages {
		if (m.Role != "user" && m.Role != "assistant") || len(m.Content) > 16<<10 || (i == 0 && m.Role != "user") {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "bad message"})
			return
		}
		msgs = append(msgs, map[string]any{"role": m.Role, "content": m.Content})
	}
	reply, err := s.cfg.Complete(r.Context(), msgs)
	if err != nil {
		s.log.Error("grill", "err", err)
		writeJSON(w, http.StatusBadGateway, map[string]any{"error": "the model call failed: " + err.Error()})
		return
	}
	if reply == "" {
		writeJSON(w, http.StatusBadGateway, map[string]any{"error": "the model returned an empty reply; try again"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"reply": reply})
}

// grillContext states the strategy under review and its closed-trade record.
func (s *Server) grillContext(ctx context.Context, name, mode, draft, brief string) string {
	var sb strings.Builder
	fmt.Fprintf(&sb, "Strategy under review: %q (mode: %s).\n", name, mode)
	if strings.TrimSpace(draft) != "" {
		fmt.Fprintf(&sb, "Current draft prompt:\n<<<\n%s\n>>>\n", draft)
	} else {
		sb.WriteString("There is no draft yet.\n")
	}
	if strings.TrimSpace(brief) != "" {
		fmt.Fprintf(&sb, "The trader's wizard answers:\n%s\n", brief)
	}
	var n, wins int
	var total, best, worst float64
	if err := s.st.Pool.QueryRow(ctx, `SELECT count(*), count(*) FILTER (WHERE realized>0), COALESCE(sum(realized),0), COALESCE(max(realized),0), COALESCE(min(realized),0)
		FROM trades WHERE strategy_name=$1`, name).Scan(&n, &wins, &total, &best, &worst); err == nil && n > 0 {
		fmt.Fprintf(&sb, "Paper-trade record: %d closed trades, %d wins, net %.2f, best %.2f, worst %.2f.\n", n, wins, total, best, worst)
		if rows, err := s.st.Pool.Query(ctx, `SELECT instrument, side, close_reason, count(*), round(sum(realized)::numeric,2)
			FROM trades WHERE strategy_name=$1 GROUP BY 1,2,3 ORDER BY 4 DESC LIMIT 12`, name); err == nil {
			defer rows.Close()
			sb.WriteString("Breakdown (instrument, side, close reason, trades, net):\n")
			for rows.Next() {
				var in, side, why string
				var c int
				var net float64
				if rows.Scan(&in, &side, &why, &c, &net) == nil {
					fmt.Fprintf(&sb, "- %s %s %s: %d trades, %.2f\n", in, side, why, c, net)
				}
			}
		}
	} else {
		sb.WriteString("No closed paper trades are recorded for this strategy. Do not cite results.\n")
	}
	return sb.String()
}
