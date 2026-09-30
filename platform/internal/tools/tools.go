// Package tools is the restricted tool gateway. Every call an agent makes goes
// through Gateway.Call, which checks the fence, the allowlist and the budget
// before any executor runs. Tools are read-only; the one control tool only
// asks for a later follow-up. There is no shell, no SQL and no write tool.
package tools

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/mfittko/market-signals/platform/internal/queue"
)

const MaxOutputBytes = 8000

// MaxSnapshotBytes is the queue's creation cap; a stored snapshot never exceeds it.
// Reading it back is therefore never cut into invalid JSON.
const MaxSnapshotBytes = queue.MaxSnapshotBytes

type Def struct {
	Name        string         `json:"name"`
	Description string         `json:"description"`
	InputSchema map[string]any `json:"input_schema"`
}

func obj(props map[string]any) map[string]any {
	return map[string]any{"type": "object", "properties": props, "additionalProperties": false}
}

// Definitions lists every tool the gateway can execute. An agent only sees the
// subset in its allowlist.
func Definitions() []Def {
	return []Def{
		{"get_snapshot", "The frozen decision-point snapshot this run was created for: event, price, supertrend, strategy, portfolio and news context at the moment of the event.", obj(map[string]any{})},
		{"get_portfolio", "The CURRENT paper portfolio from the engine: equity, cash, halted flag and open positions.", obj(map[string]any{})},
		{"get_recent_candles", "Recent COMPLETE candles for this agent's instrument and granularity (the forming candle is never returned).",
			obj(map[string]any{"count": map[string]any{"type": "integer", "minimum": 1, "maximum": 120}})},
		{"get_recent_signals", "Recent supertrend signals for this agent's instrument and granularity, newest first.",
			obj(map[string]any{"limit": map[string]any{"type": "integer", "minimum": 1, "maximum": 20}})},
		{"schedule_followup", "Ask to be re-run with fresh state after a delay (10-3600 seconds). Your current proposal is recorded as interim.",
			obj(map[string]any{"seconds": map[string]any{"type": "integer", "minimum": 10, "maximum": 3600}, "reason": map[string]any{"type": "string"}})},
	}
}

// Engine reads the deterministic engine's read-only HTTP API.
type Engine struct {
	BaseURL string
	Client  *http.Client
	mu      sync.Mutex
	cache   map[string]cached
}

func NewEngine(base string) *Engine {
	return &Engine{BaseURL: strings.TrimRight(base, "/"), Client: &http.Client{Timeout: 10 * time.Second}}
}

func (e *Engine) Get(ctx context.Context, path string, q url.Values, out any) error {
	body, err := e.fetch(ctx, path, q)
	if err != nil {
		return err
	}
	return json.Unmarshal(body, out)
}

type cached struct {
	at   time.Time
	body []byte
}

// GetCached is Get with a short-lived response cache, for read-only data that many
// page loads ask for at once. A failed call is never cached.
func (e *Engine) GetCached(ctx context.Context, ttl time.Duration, path string, q url.Values, out any) error {
	key := path + "?" + q.Encode()
	e.mu.Lock()
	c, ok := e.cache[key]
	e.mu.Unlock()
	if ok && time.Since(c.at) < ttl {
		return json.Unmarshal(c.body, out)
	}
	body, err := e.fetch(ctx, path, q)
	if err != nil {
		return err
	}
	e.mu.Lock()
	if e.cache == nil || len(e.cache) > 256 { // ponytail: drop everything at 256 entries, an LRU if it ever matters
		e.cache = map[string]cached{}
	}
	e.cache[key] = cached{at: time.Now(), body: body}
	e.mu.Unlock()
	return json.Unmarshal(body, out)
}

func (e *Engine) fetch(ctx context.Context, path string, q url.Values) ([]byte, error) {
	if e == nil || e.BaseURL == "" {
		return nil, errors.New("engine URL is not configured")
	}
	u := e.BaseURL + path
	if len(q) > 0 {
		u += "?" + q.Encode()
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return nil, err
	}
	resp, err := e.Client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("engine unreachable: %w", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("engine %s returned %d", path, resp.StatusCode)
	}
	return body, nil
}

func bound(v any) (string, error) { return boundTo(v, MaxOutputBytes) }

// boundTo encodes without HTML escaping. Escaping turns each <, > and & into six bytes, so a
// snapshot that passed the ingest cap could grow past it here and be cut into invalid JSON.
func boundTo(v any, max int) (string, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return "", err
	}
	b := bytes.TrimSuffix(buf.Bytes(), []byte("\n"))
	if len(b) > max {
		return string(b[:max]) + `..."[truncated]`, nil
	}
	return string(b), nil
}

// Formed reports whether an engine chart candle is a closed bar. Stored history
// carries no complete field; only the forming tail is marked complete:false or
// partial:true.
func Formed(c map[string]any) bool {
	complete, set := c["complete"].(bool)
	partial, _ := c["partial"].(bool)
	return (!set || complete) && !partial
}

func clampInt(args json.RawMessage, key string, def, lo, hi int) int {
	var m map[string]any
	_ = json.Unmarshal(args, &m)
	v, ok := m[key].(float64)
	if !ok {
		return def
	}
	n := int(v)
	if n < lo {
		return lo
	}
	if n > hi {
		return hi
	}
	return n
}

// Exec runs one already-authorized tool. Instrument and granularity always come
// from the snapshot, never from arguments, so an agent cannot read outside its scope.
func Exec(ctx context.Context, eng *Engine, st *queue.Store, attemptID, fence int64, tc *queue.ToolContext, name string, args json.RawMessage) (string, error) {
	switch name {
	case "get_snapshot":
		return boundTo(json.RawMessage(tc.Snapshot.Payload), MaxSnapshotBytes)
	case "get_portfolio":
		var raw struct {
			Portfolio struct {
				Equity    float64          `json:"equity"`
				Cash      float64          `json:"cash"`
				Halted    bool             `json:"halted"`
				Unreal    float64          `json:"unrealized"`
				Positions []map[string]any `json:"positions"`
			} `json:"portfolio"`
		}
		if err := eng.Get(ctx, "/api/portfolio", nil, &raw); err != nil {
			return "", err
		}
		keep := []string{"id", "instrument", "side", "notional", "entry_price", "stop", "target", "last_mark", "unrealized", "granularity"}
		ps := []map[string]any{}
		for _, p := range raw.Portfolio.Positions {
			m := map[string]any{}
			for _, k := range keep {
				if v, ok := p[k]; ok {
					m[k] = v
				}
			}
			ps = append(ps, m)
		}
		return bound(map[string]any{"equity": raw.Portfolio.Equity, "cash": raw.Portfolio.Cash, "halted": raw.Portfolio.Halted, "unrealized": raw.Portfolio.Unreal, "positions": ps})
	case "get_recent_candles":
		n := clampInt(args, "count", 30, 1, 120)
		var raw struct {
			Candles []map[string]any `json:"candles"`
		}
		q := url.Values{"instrument": {tc.Snapshot.Instrument}, "granularity": {tc.Snapshot.Granularity}}
		if err := eng.Get(ctx, "/api/chart", q, &raw); err != nil {
			return "", err
		}
		done := []map[string]any{}
		dropped := 0
		for _, c := range raw.Candles {
			if !Formed(c) {
				dropped++
				continue
			}
			done = append(done, map[string]any{"time": c["time"], "open": c["open"], "high": c["high"], "low": c["low"], "close": c["close"], "volume": c["volume"]})
		}
		if len(done) > n {
			done = done[len(done)-n:]
		}
		return bound(map[string]any{"instrument": tc.Snapshot.Instrument, "granularity": tc.Snapshot.Granularity, "candles": done, "provisionalDropped": dropped})
	case "get_recent_signals":
		n := clampInt(args, "limit", 10, 1, 20)
		var raw struct {
			Signals []map[string]any `json:"signals"`
		}
		q := url.Values{"instrument": {tc.Snapshot.Instrument}, "granularity": {tc.Snapshot.Granularity}, "limit": {fmt.Sprint(n)}}
		if err := eng.Get(ctx, "/api/signals", q, &raw); err != nil {
			return "", err
		}
		return bound(map[string]any{"signals": raw.Signals})
	case "schedule_followup":
		var a struct {
			Seconds int    `json:"seconds"`
			Reason  string `json:"reason"`
		}
		if err := json.Unmarshal(args, &a); err != nil {
			return "", fmt.Errorf("bad arguments: %w", err)
		}
		if len(a.Reason) > 200 {
			a.Reason = a.Reason[:200]
		}
		if err := st.SetPendingWait(ctx, attemptID, fence, a.Seconds, a.Reason); err != nil {
			return "", err
		}
		return bound(map[string]any{"ok": true, "note": "follow-up recorded; finish your answer now"})
	}
	return "", fmt.Errorf("unknown tool %q", name)
}
