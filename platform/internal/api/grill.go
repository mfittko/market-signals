package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
)

// Grill mode: a coach interviews the trader about one strategy, one question at a
// time, grounded in that strategy's paper-trade record, and proposes a revised
// prompt in a fenced block. The console applies the block to its editor. Nothing
// is saved until the trader saves a new version.

const grillSystem = `You are a trading-strategy coach. The trader keeps strategies as short prompts. An automated analyst reads a strategy prompt together with a frozen market snapshot and proposes an entry or a hold. The analyst sees: an axis gate (trend strength ADX, direction, impulse, location, exhaustion), ATR, EMA 20/50/200, Bollinger position, RSI, VWAP distance, volume ratio, 20-bar extremes, higher-timeframe trends, the Supertrend flip and its age, standing rules and news headlines.
Your job is to sharpen the strategy through a guided interview and to recommend, not only to ask. The trader answers by clicking predefined options, so every question must come with them.
Reply with ONE JSON object and nothing else. No prose outside the JSON, no code fences. Shape:
{"findings":[{"issue":"<short>","fix":"<short>"}],
 "question":"<one short question>",
 "why":"<one sentence: why this matters, grounded in the record or a gap in the prompt>",
 "options":[{"label":"<short answer, under 60 chars>","detail":"<one line consequence>","recommended":true|false}],
 "recommendation":"<one or two sentences: which option you recommend and why>",
 "change":"<one line: what you will change in the prompt after this answer>",
 "prompt":"<the full revised strategy prompt, only when the trader asked for it or after about five answers, else omit>",
 "summary":"<one line of what changed, only with prompt>"}
Rules:
- "findings": the top one to three weaknesses, only in your first reply. Omit later.
- Ask exactly ONE question per reply. Give two to four concrete options with numbers, such as thresholds in ATR or ADX. Set "recommended":true on exactly one option in every question. This is required, the console shows a button for it. Explain the pick in "recommendation". Base recommendations on the supplied trade record and on how the analyst can act on a rule.
- The trader can also type a free answer or skip. Treat "Skip" as no change and move to the next weakness.
- Use only the numbers in the supplied record. Never invent performance figures. With no record, say the recommendation rests on general practice.
- A good prompt is concrete: numeric thresholds, stops sized in ATR, when to hold, what invalidates the idea. Keep the trader's existing structure and wording: change only what the answers justify, and return the full text at whatever length it needs.
- Stay on strategy. This is a paper-trading research tool, not financial advice.`

type chatMsg struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

// A grill history message holds either a typed answer or a raw coach reply fed back.
// A coach reply can carry a full revised prompt (maxPrompt) plus the JSON around it,
// and the body cap leaves room for 30 such messages with JSON escaping, the draft and the brief.
const maxGrillMsg = maxPrompt + 16<<10

const maxGrillBody = 2 << 20

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
	if !decode(w, r, &b, maxGrillBody) {
		return
	}
	// a trimmed history window can start on a coach turn; the model needs a user turn first
	for len(b.Messages) > 0 && b.Messages[0].Role == "assistant" {
		b.Messages = b.Messages[1:]
	}
	if len(b.Messages) == 0 || len(b.Messages) > 30 || len(b.Draft) > maxPrompt || len(b.Brief) > 8<<10 {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "messages are required (up to 30), draft up to 32 KB"})
		return
	}
	msgs := []map[string]any{{"role": "system", "content": grillSystem}}
	msgs = append(msgs, map[string]any{"role": "system", "content": s.grillContext(r.Context(), b.Name, b.Mode, b.Draft, b.Brief)})
	for i, m := range b.Messages {
		if (m.Role != "user" && m.Role != "assistant") || len(m.Content) > maxGrillMsg || (i == 0 && m.Role != "user") {
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
	writeJSON(w, http.StatusOK, map[string]any{"reply": reply, "turn": parseTurn(reply)})
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
			FROM trades WHERE strategy_name=$1 GROUP BY 1,2,3 ORDER BY 4 DESC, 1, 2, 3 LIMIT 12`, name); err == nil {
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

type grillOption struct {
	Label       string `json:"label"`
	Detail      string `json:"detail,omitempty"`
	Recommended bool   `json:"recommended,omitempty"`
}

type grillFinding struct {
	Issue string `json:"issue"`
	Fix   string `json:"fix,omitempty"`
}

// grillTurn is one coach turn in the shape the console renders as a question with clickable options.
type grillTurn struct {
	Findings       []grillFinding `json:"findings,omitempty"`
	Question       string         `json:"question,omitempty"`
	Why            string         `json:"why,omitempty"`
	Options        []grillOption  `json:"options,omitempty"`
	Recommendation string         `json:"recommendation,omitempty"`
	Change         string         `json:"change,omitempty"`
	Prompt         string         `json:"prompt,omitempty"`
	Summary        string         `json:"summary,omitempty"`
}

func clipStr(s string, n int) string {
	s = strings.TrimSpace(s)
	if len(s) > n {
		return strings.ToValidUTF8(s[:n], "") // drop a rune cut in half
	}
	return s
}

// parseTurn reads the coach's JSON object, tolerating prose or code fences around it.
// It returns nil when the reply is not usable, and the console then shows the raw text.
// Field sizes are capped and at most one option keeps the recommended mark.
func parseTurn(reply string) *grillTurn {
	i, j := strings.Index(reply, "{"), strings.LastIndex(reply, "}")
	if i < 0 || j <= i {
		return nil
	}
	var t grillTurn
	if err := json.Unmarshal([]byte(reply[i:j+1]), &t); err != nil {
		return nil
	}
	t.Question, t.Why = clipStr(t.Question, 400), clipStr(t.Why, 400)
	t.Recommendation, t.Change, t.Summary = clipStr(t.Recommendation, 600), clipStr(t.Change, 300), clipStr(t.Summary, 300)
	t.Prompt = clipStr(t.Prompt, maxPrompt)
	if len(t.Findings) > 3 {
		t.Findings = t.Findings[:3]
	}
	for k := range t.Findings {
		t.Findings[k].Issue, t.Findings[k].Fix = clipStr(t.Findings[k].Issue, 200), clipStr(t.Findings[k].Fix, 300)
	}
	if len(t.Options) > 5 {
		t.Options = t.Options[:5]
	}
	seen := false
	kept := t.Options[:0]
	for _, o := range t.Options {
		o.Label, o.Detail = clipStr(o.Label, 80), clipStr(o.Detail, 200)
		if o.Label == "" {
			continue
		}
		if o.Recommended && seen {
			o.Recommended = false
		}
		seen = seen || o.Recommended
		kept = append(kept, o)
	}
	t.Options = kept
	// the model sometimes names its pick in the recommendation text without setting the flag
	if !seen {
		for k := range t.Options {
			if strings.Contains(strings.ToLower(t.Recommendation), strings.ToLower(t.Options[k].Label)) {
				t.Options[k].Recommended = true
				break
			}
		}
	}
	if t.Question == "" && t.Prompt == "" && len(t.Findings) == 0 {
		return nil
	}
	return &t
}
