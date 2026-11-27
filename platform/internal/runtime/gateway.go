package runtime

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

// ProviderConfig is one OpenAI-shaped provider. It is also the body of GET /api/v1/runtime/llm-config.
type ProviderConfig struct {
	Configured bool   `json:"configured"`
	BaseURL    string `json:"baseUrl"`
	APIKey     string `json:"apiKey"`
	Model      string `json:"model"`
}

// ConfigSource returns the provider config. The gateway calls it once per model call.
type ConfigSource func(ctx context.Context) (ProviderConfig, error)

const (
	defaultDeadline = 120 * time.Second
	breakerFailures = 5
	breakerOpen     = 60 * time.Second
)

// ModelError reasons.
const (
	ReasonNotConfigured = "not_configured"
	ReasonTimeout       = "timeout"
	ReasonBreakerOpen   = "breaker_open"
	ReasonProvider      = "provider"
)

// ModelError is the one error a model call returns. Error() names only the reason, the provider and the
// HTTP status, so it never carries the API key, a base URL secret or the provider's reply.
type ModelError struct {
	Provider string // the chat endpoint without userinfo and query
	Reason   string
	Status   int
	Err      error
}

func (e *ModelError) Error() string {
	s := "model gateway: " + e.Reason
	if e.Provider != "" {
		s += " (" + e.Provider + ")"
	}
	if e.Status != 0 {
		s += fmt.Sprintf(" status %d", e.Status)
	}
	return s
}

func (e *ModelError) Unwrap() error { return e.Err }

// IsNotConfigured reports a model call that failed because no provider is configured.
func IsNotConfigured(err error) bool {
	var m *ModelError
	return errors.As(err, &m) && m.Reason == ReasonNotConfigured
}

// Gateway makes every model call: it reads the provider config per call, bounds the call with a deadline and
// keeps one circuit breaker per provider endpoint in memory.
type Gateway struct {
	Source   ConfigSource
	HTTP     *http.Client // no fixed timeout: the deadline bounds the call
	Deadline time.Duration
	Now      func() time.Time
	Log      *slog.Logger

	mu       sync.Mutex
	breakers map[string]*breaker
}

func NewGateway(src ConfigSource, log *slog.Logger) *Gateway {
	if log == nil {
		log = slog.New(slog.NewTextHandler(io.Discard, nil))
	}
	return &Gateway{Source: src, HTTP: &http.Client{}, Deadline: defaultDeadline, Now: time.Now, Log: log, breakers: map[string]*breaker{}}
}

// breaker opens after breakerFailures consecutive counted failures and fails calls at once for breakerOpen.
// It then admits exactly one probe; the probe's result closes or reopens it.
type breaker struct {
	fails     int
	openUntil time.Time
	probing   bool
}

func (g *Gateway) admit(key string, now time.Time) bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	b := g.breakers[key]
	if b == nil {
		b = &breaker{}
		g.breakers[key] = b
	}
	if b.fails < breakerFailures {
		return true
	}
	if now.Before(b.openUntil) || b.probing {
		return false
	}
	b.probing = true
	return true
}

// record notes one call result. Only counted failures and successes move the breaker; a probe whose result
// does not count lets the next call probe again.
func (g *Gateway) record(key string, ok, counted bool, now time.Time) {
	g.mu.Lock()
	defer g.mu.Unlock()
	b := g.breakers[key]
	switch {
	case ok:
		*b = breaker{}
	case counted:
		b.fails++
		if b.probing || b.fails >= breakerFailures {
			b.fails, b.openUntil = breakerFailures, now.Add(breakerOpen)
		}
	}
	b.probing = false
}

// chatURL returns the request URL and the provider key, which is the same endpoint without userinfo and query.
func chatURL(base string) (string, string, error) {
	u, err := url.Parse(strings.TrimSpace(base))
	if err != nil || u.Host == "" {
		return "", "", errors.New("invalid base URL")
	}
	u.Path = strings.TrimSuffix(strings.TrimRight(u.Path, "/"), "/v1") + "/v1/chat/completions"
	u.RawPath, u.Fragment = "", ""
	full := u.String()
	u.User, u.RawQuery = nil, ""
	return full, u.String(), nil
}

// redact removes the API key, the base URL's password and its query values from a provider reply.
func redact(s, full, apiKey string) string {
	secrets := []string{apiKey}
	if u, err := url.Parse(full); err == nil {
		if p, ok := u.User.Password(); ok {
			secrets = append(secrets, p)
		}
		for _, vs := range u.Query() {
			secrets = append(secrets, vs...)
		}
	}
	for _, v := range secrets {
		if v != "" {
			s = strings.ReplaceAll(s, v, "[redacted]")
		}
	}
	return s
}

// Chat sends one chat completion request. A request without a model gets the configured model.
func (g *Gateway) Chat(ctx context.Context, req map[string]any) (map[string]any, usage, error) {
	var u usage
	callCtx, cancel := context.WithTimeout(ctx, g.Deadline)
	defer cancel()
	cfg, err := g.Source(callCtx)
	if err != nil || !cfg.Configured {
		return nil, u, &ModelError{Reason: ReasonNotConfigured, Err: err}
	}
	full, key, err := chatURL(cfg.BaseURL)
	if err != nil {
		return nil, u, &ModelError{Reason: ReasonNotConfigured, Err: err}
	}
	if m, _ := req["model"].(string); m == "" {
		if cfg.Model == "" {
			return nil, u, &ModelError{Provider: key, Reason: ReasonNotConfigured, Err: errors.New("no model configured")}
		}
		req["model"] = cfg.Model
	}
	if !g.admit(key, g.Now()) {
		return nil, u, &ModelError{Provider: key, Reason: ReasonBreakerOpen}
	}
	msg, u, status, counted, err := g.send(callCtx, full, key, cfg.APIKey, req)
	g.record(key, err == nil, counted && ctx.Err() == nil, g.Now())
	if err == nil {
		return msg, u, nil
	}
	reason := ReasonProvider
	if errors.Is(callCtx.Err(), context.DeadlineExceeded) {
		reason = ReasonTimeout
	}
	var ue *url.Error
	if errors.As(err, &ue) {
		err = ue.Err // url.Error quotes the request URL, which may hold a secret
	}
	return nil, u, &ModelError{Provider: key, Reason: reason, Status: status, Err: err}
}

// send makes the HTTP request. counted reports a failure the breaker counts: a transport error, a deadline
// expiry, HTTP 429 or 5xx. The clipped reply body goes only to the log, with the key redacted.
func (g *Gateway) send(ctx context.Context, full, key, apiKey string, req map[string]any) (map[string]any, usage, int, bool, error) {
	var u usage
	b, _ := json.Marshal(req)
	hr, err := http.NewRequestWithContext(ctx, http.MethodPost, full, bytes.NewReader(b))
	if err != nil {
		return nil, u, 0, false, err
	}
	hr.Header.Set("Authorization", "Bearer "+apiKey)
	hr.Header.Set("Content-Type", "application/json")
	resp, err := g.HTTP.Do(hr)
	if err != nil {
		return nil, u, 0, true, err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return nil, u, 0, true, err
	}
	if resp.StatusCode != http.StatusOK {
		g.Log.Warn("model provider error", "provider", key, "status", resp.StatusCode, "body", clip(redact(string(raw), full, apiKey), 200))
		return nil, u, resp.StatusCode, resp.StatusCode == http.StatusTooManyRequests || resp.StatusCode >= 500, fmt.Errorf("http %d", resp.StatusCode)
	}
	var body struct {
		Choices []struct {
			Message map[string]any `json:"message"`
		} `json:"choices"`
		Usage struct {
			Prompt     float64 `json:"prompt_tokens"`
			Completion float64 `json:"completion_tokens"`
		} `json:"usage"`
	}
	if err := json.Unmarshal(raw, &body); err != nil || len(body.Choices) == 0 {
		return nil, u, 0, false, errors.New("the provider returned no choices")
	}
	u.PromptTokens, u.CompletionTokens = body.Usage.Prompt, body.Usage.Completion
	return body.Choices[0].Message, u, resp.StatusCode, false, nil
}
