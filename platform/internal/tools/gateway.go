package tools

import (
	"context"
	"encoding/json"
	"time"

	"github.com/mfittko/market-signals/platform/internal/queue"
)

type Gateway struct {
	Store  *queue.Store
	Engine *Engine
}

type Result struct {
	Output  string `json:"output"`
	IsError bool   `json:"isError"`
}

// Call authorizes, executes and audits one tool call. Authorization errors
// (stale, cancelled, forbidden, budget) are returned as errors; a tool's own
// failure is a Result with IsError so the model can react to it.
func (g *Gateway) Call(ctx context.Context, attemptID, fence int64, name string, args json.RawMessage) (*Result, error) {
	if len(args) == 0 {
		args = json.RawMessage(`{}`)
	}
	tc, err := g.Store.AuthorizeTool(ctx, attemptID, fence, name, args)
	if err != nil {
		return nil, err
	}
	start := time.Now()
	out, execErr := Exec(ctx, g.Engine, g.Store, attemptID, fence, tc, name, args)
	res := &Result{Output: out}
	if execErr != nil {
		res = &Result{Output: execErr.Error(), IsError: true}
	}
	preview := res.Output
	if len(preview) > 300 {
		preview = preview[:300] + "…"
	}
	ev, _ := json.Marshal(map[string]any{"tool": name, "args": json.RawMessage(args), "ok": !res.IsError, "bytes": len(res.Output), "ms": time.Since(start).Milliseconds(), "preview": preview})
	_, _ = g.Store.AppendEvent(ctx, attemptID, fence, "tool_call", ev)
	return res, nil
}
