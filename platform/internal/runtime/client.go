// Package runtime holds the worker side: the control-plane client, the
// versioned runtime adapter contract and the shipped adapters.
package runtime

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/mfittko/market-signals/platform/internal/queue"
	"github.com/mfittko/market-signals/platform/internal/tools"
)

// ContractVersion is bumped on any breaking change to Runtime or the protocol.
const ContractVersion = "1"

type Client struct {
	Base  string
	Token string
	HTTP  *http.Client
}

func NewClient(base, token string) *Client {
	return &Client{Base: base, Token: token, HTTP: &http.Client{Timeout: 60 * time.Second}}
}

type APIError struct {
	Status int
	Code   string
	Detail string
}

func (e *APIError) Error() string {
	return fmt.Sprintf("control plane %d %s %s", e.Status, e.Code, e.Detail)
}

func IsStale(err error) bool {
	var a *APIError
	return errors.As(err, &a) && a.Status == http.StatusConflict && a.Code == "stale"
}

func IsCancelled(err error) bool {
	var a *APIError
	return errors.As(err, &a) && a.Status == http.StatusConflict && a.Code == "cancelled"
}

func (c *Client) do(ctx context.Context, method, path string, in, out any) (int, error) {
	var body io.Reader
	if in != nil {
		b, err := json.Marshal(in)
		if err != nil {
			return 0, err
		}
		body = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.Base+path, body)
	if err != nil {
		return 0, err
	}
	req.Header.Set("Authorization", "Bearer "+c.Token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 16<<20))
	if resp.StatusCode == http.StatusNoContent {
		return resp.StatusCode, nil
	}
	if resp.StatusCode >= 300 {
		var e struct{ Error, Detail string }
		_ = json.Unmarshal(raw, &e)
		return resp.StatusCode, &APIError{Status: resp.StatusCode, Code: e.Error, Detail: e.Detail}
	}
	if out != nil {
		if err := json.Unmarshal(raw, out); err != nil {
			return resp.StatusCode, err
		}
	}
	return resp.StatusCode, nil
}

func (c *Client) Claim(ctx context.Context, workerID string, runtimes []string, caps any) (*queue.Claim, error) {
	var cl queue.Claim
	code, err := c.do(ctx, http.MethodPost, "/api/v1/runtime/claim", map[string]any{"workerId": workerID, "runtimes": runtimes, "capabilities": caps}, &cl)
	if err != nil || code == http.StatusNoContent {
		return nil, err
	}
	return &cl, nil
}

func (c *Client) ToolDefs(ctx context.Context) ([]tools.Def, error) {
	var out struct {
		Tools []tools.Def `json:"tools"`
	}
	_, err := c.do(ctx, http.MethodGet, "/api/v1/runtime/tools", nil, &out)
	return out.Tools, err
}

type Attempt struct{ ID, Fence int64 }

func (c *Client) Heartbeat(ctx context.Context, a Attempt) (cancel bool, err error) {
	var out struct{ Cancel bool }
	_, err = c.do(ctx, http.MethodPost, "/api/v1/runtime/heartbeat", map[string]any{"attemptId": a.ID, "fence": a.Fence}, &out)
	return out.Cancel, err
}

func (c *Client) Event(ctx context.Context, a Attempt, kind string, payload any) error {
	_, err := c.do(ctx, http.MethodPost, "/api/v1/runtime/events", map[string]any{"attemptId": a.ID, "fence": a.Fence, "kind": kind, "payload": payload}, nil)
	return err
}

func (c *Client) ToolCall(ctx context.Context, a Attempt, name string, args json.RawMessage) (*tools.Result, error) {
	var r tools.Result
	_, err := c.do(ctx, http.MethodPost, "/api/v1/runtime/tools/call", map[string]any{"attemptId": a.ID, "fence": a.Fence, "name": name, "args": args}, &r)
	return &r, err
}

func (c *Client) Complete(ctx context.Context, a Attempt, in queue.CompleteInput) (*queue.CompleteOutcome, error) {
	var out queue.CompleteOutcome
	_, err := c.do(ctx, http.MethodPost, "/api/v1/runtime/complete", map[string]any{"attemptId": a.ID, "fence": a.Fence, "proposal": in.Proposal, "usage": in.Usage, "stopReason": in.StopReason}, &out)
	return &out, err
}

func (c *Client) Fail(ctx context.Context, a Attempt, msg string, retryable bool) error {
	_, err := c.do(ctx, http.MethodPost, "/api/v1/runtime/fail", map[string]any{"attemptId": a.ID, "fence": a.Fence, "error": msg, "retryable": retryable}, nil)
	return err
}

func (c *Client) Cancelled(ctx context.Context, a Attempt) error {
	_, err := c.do(ctx, http.MethodPost, "/api/v1/runtime/cancelled", map[string]any{"attemptId": a.ID, "fence": a.Fence}, nil)
	return err
}
