package runtime_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/mfittko/market-signals/platform/internal/runtime"
)

// usageStub answers 200 with usage, or without it when withUsage is false.
func usageStub(t *testing.T, withUsage bool) (*httptest.Server, *atomic.Int32) {
	t.Helper()
	var hits atomic.Int32
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		body := map[string]any{"choices": []any{map[string]any{"message": map[string]any{"content": "ok"}}}}
		if withUsage {
			body["usage"] = map[string]any{"prompt_tokens": 120, "completion_tokens": 30}
		}
		json.NewEncoder(w).Encode(body)
	}))
	t.Cleanup(s.Close)
	return s, &hits
}

func capped(base string, capReached bool) runtime.ConfigSource {
	return func(context.Context) (runtime.ProviderConfig, error) {
		return runtime.ProviderConfig{Configured: true, BaseURL: base, APIKey: fakeKey, Model: "m", CapReached: capReached}, nil
	}
}

func chat(g *runtime.Gateway, ctx context.Context) (map[string]any, error) {
	msg, _, err := g.Chat(ctx, map[string]any{"messages": []any{}, "max_tokens": 700})
	return msg, err
}

func TestGatewayRecordsAnsweredCallsWithSiteRunAndUsage(t *testing.T) {
	s, _ := usageStub(t, true)
	g, _, rec := recorded(fixed(s.URL), nil)
	if _, err := chat(g, runtime.WithCall(context.Background(), "coach", 7)); err != nil {
		t.Fatal(err)
	}
	want := runtime.SpendCall{CallSite: "coach", Provider: s.URL + "/v1/chat/completions", Model: "m", PromptTokens: 120, CompletionTokens: 30, RunID: 7}
	if got := rec.all(); len(got) != 1 || got[0] != want {
		t.Fatalf("got %+v, want one %+v", got, want)
	}
	// a context without a call site records "unknown"
	if _, err := chat(g, context.Background()); err != nil {
		t.Fatal(err)
	}
	if got := rec.all(); len(got) != 2 || got[1].CallSite != "unknown" || got[1].RunID != 0 {
		t.Fatalf("got %+v", got)
	}
}

func TestGatewayEstimatesAReplyWithoutUsageOnTheFinalModel(t *testing.T) {
	s, _ := usageStub(t, false)
	g, _, rec := recorded(fixed(s.URL), nil)
	if _, err := chat(g, runtime.WithCall(context.Background(), "news_triage", 0)); err != nil {
		t.Fatal(err)
	}
	want := runtime.SpendCall{CallSite: "news_triage", Provider: s.URL + "/v1/chat/completions", Model: "m", CompletionTokens: 700, Estimated: true}
	if got := rec.all(); len(got) != 1 || got[0] != want {
		t.Fatalf("got %+v, want one %+v", got, want)
	}
}

func TestGatewayEstimatesAReplyWithEmptyOrZeroUsage(t *testing.T) {
	for _, usage := range []string{`{}`, `{"prompt_tokens":0,"completion_tokens":0}`} {
		s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			io.WriteString(w, `{"choices":[{"message":{"content":"ok"}}],"usage":`+usage+`}`)
		}))
		g, _, rec := recorded(fixed(s.URL), nil)
		if _, err := chat(g, context.Background()); err != nil {
			t.Fatal(err)
		}
		s.Close()
		want := runtime.SpendCall{CallSite: "unknown", Provider: s.URL + "/v1/chat/completions", Model: "m", CompletionTokens: 700, Estimated: true}
		if got := rec.all(); len(got) != 1 || got[0] != want {
			t.Fatalf("usage %s: got %+v, want one %+v", usage, got, want)
		}
	}
}

// the provider bills a 200 answer even when its body does not parse
func TestGatewayEstimatesAnUnparseableAnswer(t *testing.T) {
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, "not json")
	}))
	defer s.Close()
	g, _, rec := recorded(fixed(s.URL), nil)
	_, err := chat(g, context.Background())
	var me *runtime.ModelError
	if reason(t, err) != runtime.ReasonProvider || !errors.As(err, &me) || me.Status != 0 {
		t.Fatalf("want provider with status 0, got %v", err)
	}
	want := runtime.SpendCall{CallSite: "unknown", Provider: s.URL + "/v1/chat/completions", Model: "m", CompletionTokens: 700, Estimated: true}
	if got := rec.all(); len(got) != 1 || got[0] != want {
		t.Fatalf("got %+v, want one %+v", got, want)
	}
}

// a call that never wrote its request is not billed, even when it times out
func TestGatewayRecordsNoRowForATimeoutBeforeTheRequestWasWritten(t *testing.T) {
	g, _, rec := recorded(fixed("http://provider.example.test"), nil)
	g.Deadline = 50 * time.Millisecond
	g.HTTP = &http.Client{Transport: roundTrip(func(r *http.Request) (*http.Response, error) {
		<-r.Context().Done()
		return nil, r.Context().Err()
	})}
	if _, err := chat(g, context.Background()); reason(t, err) != runtime.ReasonTimeout {
		t.Fatalf("want timeout, got %v", err)
	}
	if n := len(rec.all()); n != 0 {
		t.Fatalf("%d rows, want none", n)
	}
}

func TestGatewayRecordsATimedOutCallAsEstimated(t *testing.T) {
	block := blockingStub(t)
	g, _, rec := recorded(fixed(block.URL), nil)
	g.Deadline = 50 * time.Millisecond
	_, err := chat(g, runtime.WithCall(context.Background(), "agent", 3))
	if reason(t, err) != runtime.ReasonTimeout {
		t.Fatalf("want timeout, got %v", err)
	}
	want := runtime.SpendCall{CallSite: "agent", Provider: block.URL + "/v1/chat/completions", Model: "m", CompletionTokens: 700, Estimated: true, RunID: 3}
	if got := rec.all(); len(got) != 1 || got[0] != want {
		t.Fatalf("got %+v, want one %+v", got, want)
	}
}

// an error status whose body stalls past the deadline is an unbilled answer, not a timed-out generation
func TestGatewayRecordsNoRowForAnErrorStatusWhoseBodyStalls(t *testing.T) {
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.Copy(io.Discard, r.Body)
		w.WriteHeader(http.StatusServiceUnavailable)
		w.(http.Flusher).Flush()
		<-r.Context().Done()
	}))
	t.Cleanup(s.Close)
	g, _, rec := recorded(fixed(s.URL), nil)
	g.Deadline = 50 * time.Millisecond
	if _, err := chat(g, context.Background()); reason(t, err) != runtime.ReasonTimeout {
		t.Fatalf("want timeout, got %v", err)
	}
	if n := len(rec.all()); n != 0 {
		t.Fatalf("%d rows, want none", n)
	}
}

func TestGatewayRecordsNoRowWithoutABilledAnswer(t *testing.T) {
	failing := newStub(t, 500)
	for name, c := range map[string]struct {
		src    runtime.ConfigSource
		reason string
	}{
		"non-200 answer":  {fixed(failing.URL), runtime.ReasonProvider},
		"transport error": {fixed("http://127.0.0.1:1"), runtime.ReasonProvider},
		"config failure": {func(context.Context) (runtime.ProviderConfig, error) {
			return runtime.ProviderConfig{}, errors.New("down")
		}, runtime.ReasonNotConfigured},
	} {
		g, _, rec := recorded(c.src, nil)
		if _, err := chat(g, context.Background()); reason(t, err) != c.reason {
			t.Fatalf("%s: got %v", name, err)
		}
		if n := len(rec.all()); n != 0 {
			t.Errorf("%s: %d rows, want none", name, n)
		}
	}
	g, _, rec := recorded(fixed(failing.URL), nil)
	openBreaker(t, g)
	if n := len(rec.all()); n != 0 {
		t.Errorf("open breaker: %d rows, want none", n)
	}
}

func TestGatewayRefusesAtTheCapWithoutARequestARowOrABreakerChange(t *testing.T) {
	p := newStub(t, 500)
	capOn := atomic.Bool{}
	g, _, rec := recorded(func(context.Context) (runtime.ProviderConfig, error) {
		return runtime.ProviderConfig{Configured: true, BaseURL: p.URL, APIKey: fakeKey, Model: "m", CapReached: capOn.Load()}, nil
	}, nil)
	for range 4 {
		complete(g, context.Background())
	}
	capOn.Store(true)
	for range 3 {
		_, err := complete(g, context.Background())
		if reason(t, err) != runtime.ReasonCapReached || !runtime.IsCapReached(err) {
			t.Fatalf("want cap_reached, got %v", err)
		}
	}
	if p.hits.Load() != 4 || len(rec.all()) != 0 {
		t.Fatalf("a cap refusal sends nothing and records nothing: %d requests, %d rows", p.hits.Load(), len(rec.all()))
	}
	// the breaker still holds four failures: the fifth opens it
	capOn.Store(false)
	if _, err := complete(g, context.Background()); reason(t, err) != runtime.ReasonProvider {
		t.Fatalf("the fifth failure reaches the provider: %v", err)
	}
	if _, err := complete(g, context.Background()); reason(t, err) != runtime.ReasonBreakerOpen {
		t.Fatalf("the cap refusals must not reset the failure count: %v", err)
	}
}

func TestGatewayFailedRecordDiscardsTheReplyAndLogsAnError(t *testing.T) {
	s, _ := usageStub(t, true)
	var log bytes.Buffer
	g, _, rec := recorded(fixed(s.URL), &log)
	rec.err = errors.New("control plane 500")
	msg, err := chat(g, runtime.WithCall(context.Background(), "autogrill", 0))
	if reason(t, err) != runtime.ReasonSpendUnrecorded || !runtime.IsSpendUnrecorded(err) || msg != nil {
		t.Fatalf("want spend_unrecorded and no reply, got %v %v", msg, err)
	}
	l := log.String()
	for _, want := range []string{"level=ERROR", "callSite=autogrill", "provider=" + s.URL, "model=m"} {
		if !strings.Contains(l, want) {
			t.Fatalf("the log must name %q: %q", want, l)
		}
	}
	if strings.Contains(l, "SECRET") {
		t.Fatalf("the log leaks the key: %q", l)
	}
}

func TestGatewayWithoutARecorderRefusesBeforeTheRequest(t *testing.T) {
	s, hits := usageStub(t, true)
	g, _ := gateway(fixed(s.URL), nil)
	g.Record = nil
	if _, err := chat(g, context.Background()); reason(t, err) != runtime.ReasonSpendUnrecorded || hits.Load() != 0 {
		t.Fatalf("want spend_unrecorded and no request, got %v, %d requests", err, hits.Load())
	}
}

func TestGatewayRecordsACallWhoseCallerWentAwayAfterTheAnswer(t *testing.T) {
	g, _, rec := recorded(fixed("http://provider.test"), nil)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	g.HTTP = &http.Client{Transport: roundTrip(func(r *http.Request) (*http.Response, error) {
		cancel() // the caller goes away once the provider has answered
		body := `{"choices":[{"message":{"content":"ok"}}],"usage":{"prompt_tokens":1,"completion_tokens":2}}`
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(body)), Request: r}, nil
	})}
	if _, err := chat(g, runtime.WithCall(ctx, "coach", 0)); err != nil {
		t.Fatal(err)
	}
	if got := rec.all(); len(got) != 1 || got[0].CompletionTokens != 2 || rec.ctxErrs[0] != nil {
		t.Fatalf("the row must be recorded on a live context: %+v %v", got, rec.ctxErrs)
	}
}

func TestWorkerReadsTheCapAndRecordsThroughTheControlPlane(t *testing.T) {
	provider, hits := usageStub(t, true)
	capOn := atomic.Bool{}
	var posted []runtime.SpendCall
	plane := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer w" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		switch r.URL.Path {
		case "/api/v1/runtime/llm-config":
			json.NewEncoder(w).Encode(runtime.ProviderConfig{Configured: true, BaseURL: provider.URL, APIKey: fakeKey, Model: "m", CapReached: capOn.Load()})
		case "/api/v1/runtime/spend":
			var c runtime.SpendCall
			_ = json.NewDecoder(r.Body).Decode(&c)
			posted = append(posted, c)
			w.WriteHeader(http.StatusNoContent)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer plane.Close()
	client := runtime.NewClient(plane.URL, "w")
	g := runtime.NewGateway(client.LLMConfig, nil)
	g.Record = client.RecordSpend
	if _, err := chat(g, runtime.WithCall(context.Background(), "agent", 5)); err != nil {
		t.Fatal(err)
	}
	if len(posted) != 1 || posted[0].CallSite != "agent" || posted[0].RunID != 5 || posted[0].PromptTokens != 120 {
		t.Fatalf("the worker records through the spend route: %+v", posted)
	}
	capOn.Store(true)
	if _, err := chat(g, context.Background()); !runtime.IsCapReached(err) || hits.Load() != 1 || len(posted) != 1 {
		t.Fatalf("capReached from llm-config refuses the call: %v, %d requests, %d rows", err, hits.Load(), len(posted))
	}
	// a refused record is spend_unrecorded
	capOn.Store(false)
	g.Record = runtime.NewClient(plane.URL, "wrong").RecordSpend
	if _, err := chat(g, context.Background()); !runtime.IsSpendUnrecorded(err) {
		t.Fatalf("want spend_unrecorded, got %v", err)
	}
}

func TestAgentCallsCarryTheClaimsRunID(t *testing.T) {
	srv, _ := fakeLLM(t, toolReply("get_portfolio"), text(`{"action":"hold","reasoning":"r"}`))
	rec := &recorder{}
	in := input(&fakeTools{out: map[string]string{"get_portfolio": "{}"}}, 0)
	in.Claim.Run.ID = 42
	if _, err := runtime.NewLLM(runtime.LLMConfig{BaseURL: srv.URL, APIKey: "k", Model: "m", Record: rec.record}).Run(context.Background(), in); err != nil {
		t.Fatal(err)
	}
	got := rec.all()
	if len(got) != 2 {
		t.Fatalf("want one row per round, got %+v", got)
	}
	for _, c := range got {
		if c.CallSite != "agent" || c.RunID != 42 || c.PromptTokens != 10 || c.CompletionTokens != 5 {
			t.Fatalf("got %+v", c)
		}
	}
}
