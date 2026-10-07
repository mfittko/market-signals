package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"sync"
	"time"

	"github.com/mfittko/market-signals/platform/internal/domain"
	"github.com/mfittko/market-signals/platform/internal/queue"
	"github.com/mfittko/market-signals/platform/internal/tools"
)

// Worker claims runs and executes them with the matching runtime adapter.
type Worker struct {
	ID          string
	Client      *Client
	Runtimes    map[string]Runtime
	Concurrency int
	Poll        time.Duration
	Heartbeat   time.Duration
	RunTimeout  time.Duration
	Log         *slog.Logger
}

func (w *Worker) names() []string {
	var n []string
	for k := range w.Runtimes {
		n = append(n, k)
	}
	return n
}

func (w *Worker) caps() map[string]Capabilities {
	m := map[string]Capabilities{}
	for k, r := range w.Runtimes {
		m[k] = r.Capabilities()
	}
	return m
}

// Run blocks until ctx is done, claiming up to Concurrency runs at once.
func (w *Worker) Run(ctx context.Context) {
	sem := make(chan struct{}, w.Concurrency)
	var wg sync.WaitGroup
	defer wg.Wait()
	for {
		select {
		case <-ctx.Done():
			return
		case sem <- struct{}{}:
		}
		cl, err := w.Client.Claim(ctx, w.ID, w.names(), w.caps())
		if err != nil || cl == nil {
			<-sem
			if err != nil && ctx.Err() == nil {
				w.Log.Warn("claim failed", "err", err)
			}
			select {
			case <-ctx.Done():
				return
			case <-time.After(w.Poll):
			}
			continue
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			defer func() { <-sem }()
			w.execute(ctx, cl)
		}()
	}
}

type attemptTools struct {
	c       *Client
	a       Attempt
	allowed map[string]bool
	defs    []tools.Def
}

func (t *attemptTools) Defs() []tools.Def { return t.defs }

func (t *attemptTools) Call(ctx context.Context, name string, args json.RawMessage) (string, bool, error) {
	res, err := t.c.ToolCall(ctx, t.a, name, args)
	if err != nil {
		var ae *APIError
		if errors.As(err, &ae) && (ae.Status == 403 || ae.Status == 429) { // let the model see a denial and adapt
			return ae.Detail, true, nil
		}
		return "", false, err
	}
	return res.Output, res.IsError, nil
}

func (w *Worker) execute(parent context.Context, cl *queue.Claim) {
	log := w.Log.With("run", cl.Run.ID, "attempt", cl.Attempt.ID, "agent", cl.Agent.ID)
	att := Attempt{ID: cl.Attempt.ID, Fence: cl.Attempt.Fence}
	rt, ok := w.Runtimes[cl.Agent.Runtime]
	bg := context.WithoutCancel(parent)
	if !ok {
		_ = w.Client.Fail(bg, att, "no runtime "+cl.Agent.Runtime, false)
		return
	}
	ctx, cancel := context.WithTimeout(parent, w.RunTimeout)
	defer cancel()

	var mu sync.Mutex
	lost, cancelled := false, false
	go func() { // heartbeat: extends the lease, learns about cancellation and reassignment
		t := time.NewTicker(w.heartbeat())
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				c, err := w.Client.Heartbeat(ctx, att)
				mu.Lock()
				if IsStale(err) {
					lost = true
					cancel()
				} else if err == nil && c {
					cancelled = true
					cancel()
				}
				mu.Unlock()
			}
		}
	}()

	defs, err := w.Client.ToolDefs(ctx)
	if err != nil {
		_ = w.Client.Fail(bg, att, "tool definitions unavailable: "+err.Error(), true)
		return
	}
	allow := map[string]bool{}
	for _, n := range cl.Agent.AllowedTools {
		allow[n] = true
	}
	var visible []tools.Def
	for _, d := range defs {
		// the prediction endpoint refuses other timeframes, so such an agent never sees the tool
		if allow[d.Name] && (d.Name != "get_prediction" || domain.PredictionGranularity(cl.Agent.Granularity)) {
			visible = append(visible, d)
		}
	}
	emit := func(kind string, payload any) {
		if err := w.Client.Event(ctx, att, kind, payload); err != nil {
			if IsStale(err) {
				mu.Lock()
				lost = true
				mu.Unlock()
				cancel()
			} else if IsCancelled(err) {
				mu.Lock()
				cancelled = true
				mu.Unlock()
				cancel()
			}
		}
	}
	emit("worker", map[string]any{"worker": w.ID, "runtime": rt.Name(), "capabilities": rt.Capabilities()})
	out, runErr := rt.Run(ctx, Input{Claim: cl, Tools: &attemptTools{c: w.Client, a: att, allowed: allow, defs: visible}, Emit: emit})

	mu.Lock()
	wasLost, wasCancelled := lost, cancelled
	mu.Unlock()
	if runErr != nil && (IsCancelled(runErr)) {
		wasCancelled = true
	}
	if runErr != nil && IsStale(runErr) {
		wasLost = true
	}
	switch {
	case wasLost:
		log.Warn("attempt reassigned; abandoning without a result")
		return
	case wasCancelled:
		if err := w.Client.Cancelled(bg, att); err != nil && !IsStale(err) {
			log.Warn("cancel ack failed", "err", err)
		}
		log.Info("cancelled by operator")
		return
	case runErr != nil:
		// A shutdown cancel reaches here as context.Canceled; the run must be
		// requeued for another worker, never failed for good. The queue's
		// attempt budget still bounds genuine repeat failures.
		if err := w.Client.Fail(bg, att, runErr.Error(), true); err != nil && !IsStale(err) {
			log.Warn("fail report failed", "err", err)
		}
		log.Warn("attempt failed", "err", runErr)
		return
	case out == nil || out.Proposal == nil:
		_ = w.Client.Fail(bg, att, ErrNoProposal.Error(), false)
		return
	}
	res, err := w.Client.Complete(bg, att, queue.CompleteInput{Proposal: out.Proposal, Usage: out.Usage, StopReason: out.StopReason})
	switch {
	case IsStale(err):
		log.Warn("completion rejected as stale")
	case IsCancelled(err):
		log.Info("completion discarded: run was cancelled")
	case err != nil:
		log.Warn("completion failed", "err", err)
	default:
		log.Info("attempt finished", "status", res.Status, "action", out.Proposal.Action, "valid", res.Validation.Valid)
	}
}

// heartbeat defaults to a quarter of the 30-second server lease.
func (w *Worker) heartbeat() time.Duration {
	if w.Heartbeat > 0 {
		return w.Heartbeat
	}
	return 8 * time.Second
}
