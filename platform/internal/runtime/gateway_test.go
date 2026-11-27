package runtime_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/mfittko/market-signals/platform/internal/runtime"
)

const fakeKey = "sk-test-SECRET"

// stubProvider answers with status, or with a chat reply for 200. It counts requests.
type stubProvider struct {
	*httptest.Server
	hits   atomic.Int32
	status atomic.Int32
}

func newStub(t *testing.T, status int) *stubProvider {
	t.Helper()
	p := &stubProvider{}
	p.status.Store(int32(status))
	p.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p.hits.Add(1)
		if s := int(p.status.Load()); s != http.StatusOK {
			http.Error(w, "upstream says "+r.Header.Get("Authorization")+" key=SECRET", s)
			return
		}
		var req map[string]any
		_ = json.NewDecoder(r.Body).Decode(&req)
		json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"message": map[string]any{"role": "assistant", "content": "model " + req["model"].(string)}}}})
	}))
	t.Cleanup(p.Close)
	return p
}

func fixed(base string) runtime.ConfigSource {
	return func(context.Context) (runtime.ProviderConfig, error) {
		return runtime.ProviderConfig{Configured: true, BaseURL: base, APIKey: fakeKey, Model: "m"}, nil
	}
}

type clock struct{ t time.Time }

func (c *clock) now() time.Time { return c.t }

func gateway(src runtime.ConfigSource, log *bytes.Buffer) (*runtime.Gateway, *clock) {
	g, c, _ := recorded(src, log)
	return g, c
}

// recorded is gateway with its own capturing spend recorder.
func recorded(src runtime.ConfigSource, log *bytes.Buffer) (*runtime.Gateway, *clock, *recorder) {
	var l *slog.Logger
	if log != nil {
		l = slog.New(slog.NewTextHandler(log, nil))
	}
	g := runtime.NewGateway(src, l)
	c := &clock{t: time.Unix(1_700_000_000, 0)}
	g.Now = c.now
	rec := &recorder{}
	g.Record = rec.record
	return g, c, rec
}

func complete(g *runtime.Gateway, ctx context.Context) (string, error) {
	return (&runtime.LLM{GW: g}).Complete(ctx, []map[string]any{{"role": "user", "content": "hi"}})
}

func reason(t *testing.T, err error) string {
	t.Helper()
	var m *runtime.ModelError
	if !errors.As(err, &m) {
		t.Fatalf("want a *runtime.ModelError, got %v", err)
	}
	if !strings.HasPrefix(m.Error(), "model gateway: ") {
		t.Fatalf("error must start with the gateway prefix: %q", m.Error())
	}
	return m.Reason
}

func TestGatewayReadsTheConfigOnEveryCall(t *testing.T) {
	a, b := newStub(t, 200), newStub(t, 200)
	var calls atomic.Int32
	g, _ := gateway(func(context.Context) (runtime.ProviderConfig, error) {
		n := calls.Add(1)
		if n == 1 {
			return runtime.ProviderConfig{Configured: true, BaseURL: a.URL, APIKey: fakeKey, Model: "first"}, nil
		}
		return runtime.ProviderConfig{Configured: true, BaseURL: b.URL + "/v1/", APIKey: fakeKey, Model: "second"}, nil
	}, nil)
	for _, want := range []string{"model first", "model second"} {
		got, err := complete(g, context.Background())
		if err != nil || got != want {
			t.Fatalf("got %q %v, want %q", got, err, want)
		}
	}
	if calls.Load() != 2 || a.hits.Load() != 1 || b.hits.Load() != 1 {
		t.Fatalf("the provider change must apply on the next call: source %d, a %d, b %d", calls.Load(), a.hits.Load(), b.hits.Load())
	}
}

func TestGatewayNotConfigured(t *testing.T) {
	for name, src := range map[string]runtime.ConfigSource{
		"configured false": func(context.Context) (runtime.ProviderConfig, error) { return runtime.ProviderConfig{}, nil },
		"read failed": func(context.Context) (runtime.ProviderConfig, error) {
			return runtime.ProviderConfig{}, errors.New("control plane 401")
		},
		"no model": func(context.Context) (runtime.ProviderConfig, error) {
			return runtime.ProviderConfig{Configured: true, BaseURL: "http://127.0.0.1:1", APIKey: fakeKey}, nil
		},
	} {
		g, _ := gateway(src, nil)
		_, err := complete(g, context.Background())
		if reason(t, err) != runtime.ReasonNotConfigured || !runtime.IsNotConfigured(err) {
			t.Errorf("%s: got %v", name, err)
		}
	}
}

func TestGatewayErrorsAndLogsCarryNoSecret(t *testing.T) {
	var log bytes.Buffer
	check := func(what string, err error) {
		t.Helper()
		for _, s := range []string{err.Error(), log.String()} {
			if strings.Contains(s, "SECRET") {
				t.Fatalf("%s leaks a secret: %q", what, s)
			}
		}
	}
	failing := newStub(t, 500)
	g, _ := gateway(fixed(failing.URL+"/v1?key=SECRET"), &log)
	for range 5 {
		_, err := complete(g, context.Background())
		if reason(t, err) != runtime.ReasonProvider {
			t.Fatalf("want provider, got %v", err)
		}
		check("provider", err)
	}
	if !strings.Contains(log.String(), "upstream says") {
		t.Fatalf("the provider body belongs in the log line: %q", log.String())
	}
	_, err := complete(g, context.Background())
	if reason(t, err) != runtime.ReasonBreakerOpen {
		t.Fatalf("want breaker_open, got %v", err)
	}
	check("breaker_open", err)

	block := blockingStub(t)
	g, _ = gateway(fixed(block.URL+"?key=SECRET"), &log)
	g.Deadline = 50 * time.Millisecond
	_, err = complete(g, context.Background())
	if reason(t, err) != runtime.ReasonTimeout {
		t.Fatalf("want timeout, got %v", err)
	}
	check("timeout", err)

	g, _ = gateway(func(context.Context) (runtime.ProviderConfig, error) {
		return runtime.ProviderConfig{APIKey: fakeKey, BaseURL: "http://x?key=SECRET"}, nil
	}, &log)
	_, err = complete(g, context.Background())
	check("not_configured", err)
	// a configured source with an unparsable base URL and a failed config read: not_configured, and the
	// cause is logged without any config value
	for _, c := range []struct {
		name, cause string
		cfg         runtime.ProviderConfig
		err         error
	}{
		{"unparsable base URL", "invalid base URL", runtime.ProviderConfig{Configured: true, APIKey: fakeKey, BaseURL: "://bad?key=SECRET", Model: "m"}, nil},
		{"failed config read", "settings store down", runtime.ProviderConfig{APIKey: fakeKey, BaseURL: "http://x?key=SECRET"}, errors.New("settings store down")},
	} {
		log.Reset()
		g, _ = gateway(func(context.Context) (runtime.ProviderConfig, error) { return c.cfg, c.err }, &log)
		_, err = complete(g, context.Background())
		if reason(t, err) != runtime.ReasonNotConfigured {
			t.Fatalf("%s: want not_configured, got %v", c.name, err)
		}
		check(c.name, err)
		if l := log.String(); !strings.Contains(l, "model config unavailable") || !strings.Contains(l, c.cause) {
			t.Fatalf("%s: the cause belongs in the log: %q", c.name, l)
		}
	}
	// the transport error of an unreachable provider quotes the URL in net/http; the gateway drops it
	g, _ = gateway(fixed("http://127.0.0.1:1/v1?key=SECRET"), &log)
	_, err = complete(g, context.Background())
	check("transport", err)
	if errors.Unwrap(err) != nil && strings.Contains(errors.Unwrap(err).Error(), "SECRET") {
		t.Fatalf("the wrapped transport error leaks the URL: %v", errors.Unwrap(err))
	}
}

func blockingStub(t *testing.T) *httptest.Server {
	t.Helper()
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.Copy(io.Discard, r.Body) // the server sees the client go away only after the body is read
		<-r.Context().Done()
	}))
	t.Cleanup(s.Close)
	return s
}

func TestGatewayDeadline(t *testing.T) {
	block := blockingStub(t)
	g, _ := gateway(fixed(block.URL), nil)
	g.Deadline = 100 * time.Millisecond
	start := time.Now()
	_, err := complete(g, context.Background())
	if reason(t, err) != runtime.ReasonTimeout || time.Since(start) > 600*time.Millisecond {
		t.Fatalf("got %v after %v", err, time.Since(start))
	}

	g.Deadline = 10 * time.Second
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	start = time.Now()
	_, err = complete(g, ctx)
	if reason(t, err) != runtime.ReasonTimeout || time.Since(start) > 550*time.Millisecond {
		t.Fatalf("the earlier caller deadline must win: %v after %v", err, time.Since(start))
	}
}

func TestGatewayBreakerOpensAndFailsFast(t *testing.T) {
	p := newStub(t, 503)
	g, _ := gateway(fixed(p.URL), nil)
	for range 5 {
		if _, err := complete(g, context.Background()); reason(t, err) != runtime.ReasonProvider {
			t.Fatal(err)
		}
	}
	for range 3 {
		if _, err := complete(g, context.Background()); reason(t, err) != runtime.ReasonBreakerOpen {
			t.Fatal(err)
		}
	}
	if p.hits.Load() != 5 {
		t.Fatalf("an open breaker must make no request: %d requests", p.hits.Load())
	}
}

func openBreaker(t *testing.T, g *runtime.Gateway) {
	t.Helper()
	for range 5 {
		complete(g, context.Background())
	}
	if _, err := complete(g, context.Background()); reason(t, err) != runtime.ReasonBreakerOpen {
		t.Fatalf("breaker not open: %v", err)
	}
}

func TestGatewayHalfOpenProbe(t *testing.T) {
	p := newStub(t, 500)
	g, c := gateway(fixed(p.URL), nil)
	openBreaker(t, g)

	c.t = c.t.Add(59 * time.Second)
	if _, err := complete(g, context.Background()); reason(t, err) != runtime.ReasonBreakerOpen {
		t.Fatalf("still open before 60 s: %v", err)
	}
	c.t = c.t.Add(time.Second)
	hits := p.hits.Load()
	if _, err := complete(g, context.Background()); reason(t, err) != runtime.ReasonProvider || p.hits.Load() != hits+1 {
		t.Fatalf("the probe must reach the provider: %v", err)
	}
	if _, err := complete(g, context.Background()); reason(t, err) != runtime.ReasonBreakerOpen {
		t.Fatalf("a failed probe reopens the breaker: %v", err)
	}

	// a probe whose answer does not count leaves the breaker open and the next call probes again
	c.t = c.t.Add(60 * time.Second)
	p.status.Store(400)
	hits = p.hits.Load()
	if _, err := complete(g, context.Background()); reason(t, err) != runtime.ReasonProvider || p.hits.Load() != hits+1 {
		t.Fatalf("the probe must reach the provider: %v", err)
	}
	p.status.Store(500)
	if _, err := complete(g, context.Background()); reason(t, err) != runtime.ReasonProvider || p.hits.Load() != hits+2 {
		t.Fatalf("a probe answered 400 must admit the next probe: %v", err)
	}
	if _, err := complete(g, context.Background()); reason(t, err) != runtime.ReasonBreakerOpen || p.hits.Load() != hits+2 {
		t.Fatalf("a 5xx probe after it reopens the breaker: %v", err)
	}

	c.t = c.t.Add(60 * time.Second)
	p.status.Store(200)
	for range 3 {
		if _, err := complete(g, context.Background()); err != nil {
			t.Fatalf("a successful probe closes the breaker: %v", err)
		}
	}
	// the count starts again from zero after the close
	p.status.Store(500)
	for range 4 {
		complete(g, context.Background())
	}
	if _, err := complete(g, context.Background()); reason(t, err) != runtime.ReasonProvider {
		t.Fatalf("the fifth failure after a close still reaches the provider: %v", err)
	}
}

func TestGatewayHalfOpenAdmitsExactlyOneProbe(t *testing.T) {
	release := make(chan struct{})
	var hits atomic.Int32
	fail := atomic.Bool{}
	fail.Store(true)
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		if fail.Load() {
			http.Error(w, "down", 500)
			return
		}
		<-release
		json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"message": map[string]any{"content": "ok"}}}})
	}))
	defer s.Close()
	var once sync.Once
	unblock := func() { once.Do(func() { close(release) }) }
	defer unblock() // before s.Close, which waits for the blocked probe handler
	g, c := gateway(fixed(s.URL), nil)
	openBreaker(t, g)
	c.t = c.t.Add(60 * time.Second)
	fail.Store(false)
	var wg sync.WaitGroup
	wg.Add(1)
	go func() { defer wg.Done(); complete(g, context.Background()) }()
	for deadline := time.Now().Add(5 * time.Second); hits.Load() != 6; time.Sleep(time.Millisecond) {
		if time.Now().After(deadline) {
			t.Fatalf("the probe never reached the provider: %d requests", hits.Load())
		}
	}
	if _, err := complete(g, context.Background()); reason(t, err) != runtime.ReasonBreakerOpen {
		t.Fatalf("a second call during the probe must fail fast: %v", err)
	}
	unblock()
	wg.Wait()
	if hits.Load() != 6 {
		t.Fatalf("only the probe may reach the provider: %d", hits.Load())
	}
}

func TestGatewayFailureClassification(t *testing.T) {
	for _, c := range []struct {
		status int
		counts bool
	}{{400, false}, {401, false}, {429, true}, {500, true}, {502, true}, {503, true}} {
		p := newStub(t, c.status)
		g, _ := gateway(fixed(p.URL), nil)
		for range 6 {
			complete(g, context.Background())
		}
		if opened := p.hits.Load() == 5; opened != c.counts {
			t.Errorf("HTTP %d: counted %v, want %v (%d requests)", c.status, opened, c.counts, p.hits.Load())
		}
	}

	p := newStub(t, 200)
	g, _ := gateway(fixed(p.URL), nil)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	for range 6 {
		complete(g, ctx)
	}
	if _, err := complete(g, context.Background()); err != nil {
		t.Fatalf("caller cancellation must not count: %v", err)
	}

	bad := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("not json")) }))
	defer bad.Close()
	g, _ = gateway(fixed(bad.URL), nil)
	for range 6 {
		if _, err := complete(g, context.Background()); reason(t, err) != runtime.ReasonProvider {
			t.Fatalf("an unparsable body must not count: %v", err)
		}
	}
}

func TestGatewayDeadlineAndTransportFailuresCount(t *testing.T) {
	block := blockingStub(t)
	for name, c := range map[string]struct {
		base     string
		deadline time.Duration
		caller   time.Duration
	}{
		"caller deadline":  {block.URL, 10 * time.Second, 20 * time.Millisecond},
		"gateway deadline": {block.URL, 20 * time.Millisecond, 0},
		"transport error":  {"http://127.0.0.1:1", 10 * time.Second, 0},
	} {
		g, _ := gateway(fixed(c.base), nil)
		g.Deadline = c.deadline
		for range 5 {
			ctx, cancel := context.Background(), context.CancelFunc(func() {})
			if c.caller > 0 {
				ctx, cancel = context.WithTimeout(ctx, c.caller)
			}
			_, err := complete(g, ctx)
			cancel()
			if r := reason(t, err); r == runtime.ReasonBreakerOpen {
				t.Fatalf("%s: opened too early", name)
			}
		}
		if _, err := complete(g, context.Background()); reason(t, err) != runtime.ReasonBreakerOpen {
			t.Errorf("%s: 5 failures must open the breaker: %v", name, err)
		}
	}
}

func TestGatewayStaleCallDoesNotEndTheProbe(t *testing.T) {
	releaseStale, releaseProbe := make(chan struct{}), make(chan struct{})
	var hits atomic.Int32
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch n := hits.Add(1); {
		case n == 1:
			<-releaseStale
		case n == 7:
			<-releaseProbe
		case n < 7:
			http.Error(w, "down", 500)
			return
		}
		json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"message": map[string]any{"content": "ok"}}}})
	}))
	defer s.Close()
	release := func(ch chan struct{}) {
		select {
		case <-ch:
		default:
			close(ch)
		}
	}
	defer release(releaseProbe) // before s.Close, which waits for the blocked handlers
	defer release(releaseStale)
	g, c := gateway(fixed(s.URL), nil)
	wait := func(n int32) {
		for deadline := time.Now().Add(5 * time.Second); hits.Load() != n; time.Sleep(time.Millisecond) {
			if time.Now().After(deadline) {
				t.Fatalf("want %d requests, got %d", n, hits.Load())
			}
		}
	}
	var stale, probe sync.WaitGroup
	stale.Add(1)
	go func() { defer stale.Done(); complete(g, context.Background()) }() // admitted while closed
	wait(1)
	openBreaker(t, g)
	c.t = c.t.Add(60 * time.Second)
	probe.Add(1)
	go func() { defer probe.Done(); complete(g, context.Background()) }()
	wait(7)
	release(releaseStale)
	stale.Wait()
	if _, err := complete(g, context.Background()); reason(t, err) != runtime.ReasonBreakerOpen || hits.Load() != 7 {
		t.Fatalf("a stale success must not end the probe: %v, %d requests", err, hits.Load())
	}
	release(releaseProbe)
	probe.Wait()
	if _, err := complete(g, context.Background()); err != nil {
		t.Fatalf("the probe's success closes the breaker: %v", err)
	}
}

type roundTrip func(*http.Request) (*http.Response, error)

func (f roundTrip) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestGatewayProviderKeyIgnoresHostCaseAndDefaultPort(t *testing.T) {
	for _, forms := range [][]string{
		{"https://API.Example.test/v1", "https://api.example.test:443/v1", "https://api.example.test/v1/"},
		{"http://Models.Example.test", "http://models.example.test:80", "http://models.example.test/v1"},
	} {
		var hits atomic.Int32
		i := 0
		g, _ := gateway(func(context.Context) (runtime.ProviderConfig, error) {
			base := forms[i%len(forms)]
			i++
			return runtime.ProviderConfig{Configured: true, BaseURL: base, APIKey: fakeKey, Model: "m"}, nil
		}, nil)
		g.HTTP = &http.Client{Transport: roundTrip(func(r *http.Request) (*http.Response, error) {
			hits.Add(1)
			return &http.Response{StatusCode: 500, Body: io.NopCloser(strings.NewReader("down")), Request: r}, nil
		})}
		for range 5 {
			complete(g, context.Background())
		}
		for range len(forms) {
			if _, err := complete(g, context.Background()); reason(t, err) != runtime.ReasonBreakerOpen {
				t.Fatalf("%v must share one breaker: %v", forms, err)
			}
		}
		if hits.Load() != 5 {
			t.Fatalf("%v: %d requests, want 5", forms, hits.Load())
		}
	}
}

func TestGatewayBreakersArePerProvider(t *testing.T) {
	a, b := newStub(t, 500), newStub(t, 200)
	base := a.URL
	g, _ := gateway(func(context.Context) (runtime.ProviderConfig, error) {
		return runtime.ProviderConfig{Configured: true, BaseURL: base, APIKey: fakeKey, Model: "m"}, nil
	}, nil)
	openBreaker(t, g)
	base = b.URL
	if _, err := complete(g, context.Background()); err != nil {
		t.Fatalf("a second provider has its own breaker: %v", err)
	}
}

func TestWorkerReadsTheConfigFromTheControlPlaneOnEveryModelCall(t *testing.T) {
	provider, reqs := fakeLLM(t, toolReply("get_portfolio"), text(`{"action":"hold","reasoning":"r"}`))
	var reads atomic.Int32
	plane := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/runtime/llm-config" || r.Header.Get("Authorization") != "Bearer w" {
			w.WriteHeader(http.StatusUnauthorized)
			w.Write([]byte(`{"error":"unauthorized","apiKey":"sk-test-SECRET"}`))
			return
		}
		reads.Add(1)
		json.NewEncoder(w).Encode(runtime.ProviderConfig{Configured: true, BaseURL: provider.URL, APIKey: fakeKey, Model: "from-plane"})
	}))
	defer plane.Close()

	g, _ := gateway(runtime.NewClient(plane.URL, "w").LLMConfig, nil)
	ft := &fakeTools{out: map[string]string{"get_portfolio": "{}"}}
	if _, err := (&runtime.LLM{GW: g}).Run(context.Background(), input(ft, 0)); err != nil {
		t.Fatal(err)
	}
	if reads.Load() != 2 || len(*reqs) != 2 || (*reqs)[1]["model"] != "from-plane" {
		t.Fatalf("want one config read per model call: %d reads, %d calls", reads.Load(), len(*reqs))
	}

	g, _ = gateway(runtime.NewClient(plane.URL, "wrong").LLMConfig, nil)
	_, err := complete(g, context.Background())
	if reason(t, err) != runtime.ReasonNotConfigured || strings.Contains(err.Error(), "SECRET") || strings.Contains(errors.Unwrap(err).Error(), "SECRET") {
		t.Fatalf("a refused config read is not_configured and keeps only error and detail: %v / %v", err, errors.Unwrap(err))
	}
}

func TestLLMSendsTemperatureZeroOnEveryRound(t *testing.T) {
	srv, reqs := fakeLLM(t, toolReply("get_portfolio"), toolReply("get_portfolio"), text(`{"action":"hold","reasoning":"r"}`))
	ft := &fakeTools{out: map[string]string{"get_portfolio": "{}"}}
	if _, err := runtime.NewLLM(runtime.LLMConfig{BaseURL: srv.URL, APIKey: "k", Model: "m", Record: shared.record}).Run(context.Background(), input(ft, 0)); err != nil {
		t.Fatal(err)
	}
	if len(*reqs) != 3 {
		t.Fatalf("want 3 rounds, got %d", len(*reqs))
	}
	for i, r := range *reqs {
		if r["temperature"] != float64(0) {
			t.Fatalf("round %d sent temperature %v", i+1, r["temperature"])
		}
	}
}

func TestLLMRoundStepNamesTheResolvedModelAndProvider(t *testing.T) {
	a, _ := fakeLLM(t, toolReply("get_portfolio"))
	b, _ := fakeLLM(t, text(`{"action":"hold","reasoning":"r"}`))
	var calls atomic.Int32
	g, _ := gateway(func(context.Context) (runtime.ProviderConfig, error) {
		if calls.Add(1) == 1 {
			// userinfo and a query must never reach the trail
			base := strings.Replace(a.URL, "http://", "http://user:pw-SECRET@", 1) + "/v1?key=q-SECRET"
			return runtime.ProviderConfig{Configured: true, BaseURL: base, APIKey: fakeKey, Model: "first"}, nil
		}
		return runtime.ProviderConfig{Configured: true, BaseURL: b.URL, APIKey: fakeKey, Model: "second"}, nil
	}, nil)
	var steps []string
	in := input(&fakeTools{out: map[string]string{"get_portfolio": "{}"}}, 0)
	in.Emit = func(kind string, p any) {
		if kind == "step" {
			steps = append(steps, p.(map[string]any)["text"].(string))
		}
	}
	if _, err := (&runtime.LLM{GW: g}).Run(context.Background(), in); err != nil {
		t.Fatal(err)
	}
	want := []string{
		"round 1: asked first at " + a.URL + "/v1/chat/completions",
		"round 2: asked second at " + b.URL + "/v1/chat/completions",
	}
	if strings.Join(steps, "\n") != strings.Join(want, "\n") {
		t.Fatalf("steps %q, want %q", steps, want)
	}

	// a failed round still emits its step, with a fallback word for what never resolved
	g, _ = gateway(func(context.Context) (runtime.ProviderConfig, error) { return runtime.ProviderConfig{}, nil }, nil)
	steps = nil
	if _, err := (&runtime.LLM{GW: g}).Run(context.Background(), in); err == nil {
		t.Fatal("an unconfigured gateway must fail the run")
	}
	if len(steps) != 1 || steps[0] != "round 1: asked no model at no provider" {
		t.Fatalf("steps %q", steps)
	}
}
