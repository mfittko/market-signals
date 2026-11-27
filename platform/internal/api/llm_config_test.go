package api

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"maps"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"

	"github.com/mfittko/market-signals/platform/internal/queue"
	"github.com/mfittko/market-signals/platform/internal/runtime"
	"github.com/mfittko/market-signals/platform/internal/settings"
	"github.com/mfittko/market-signals/platform/internal/testutil"
)

// unconfigured is the api's gateway Complete with a source that has no model.
func unconfigured() func(context.Context, []map[string]any) (string, error) {
	src := func(context.Context) (runtime.ProviderConfig, error) { return runtime.ProviderConfig{}, nil }
	return (&runtime.LLM{GW: runtime.NewGateway(src, nil)}).Complete
}

func TestTriageNewsPassesItemsThroughWhenNoModelIsConfigured(t *testing.T) {
	gw := runtime.NewGateway(func(context.Context) (runtime.ProviderConfig, error) { return runtime.ProviderConfig{}, nil }, nil)
	calls := 0
	s := &Server{log: slog.New(slog.DiscardHandler), tri: newNewsTriage()}
	s.cfg.Complete = func(ctx context.Context, msgs []map[string]any) (string, error) {
		calls++
		return (&runtime.LLM{GW: gw}).Complete(ctx, msgs)
	}
	s.cfg.ModelConfigured = gw.Configured
	raw := json.RawMessage(`{"ok":true,"items":[{"title":"Oil rises"}]}`)
	// the first answer already passes through: no pending marker and no model call
	for range 2 {
		if got := s.triageNews(context.Background(), "WTICO/USD", "WTI Crude", raw); string(got) != string(raw) {
			t.Fatalf("an unconfigured model must pass the items through unmarked: %s", got)
		}
		s.tri.wg.Wait()
		if calls != 0 {
			t.Fatalf("an unconfigured model must start no model call: %d calls", calls)
		}
	}
}

func TestTriageNewsDoesNotLatchOffOnAFailedConfigRead(t *testing.T) {
	reads := 0
	gw := runtime.NewGateway(func(context.Context) (runtime.ProviderConfig, error) {
		reads++
		if reads == 1 {
			return runtime.ProviderConfig{}, context.Canceled
		}
		return runtime.ProviderConfig{Configured: true, BaseURL: "http://127.0.0.1:1", APIKey: "k", Model: "m"}, nil
	}, nil)
	calls := 0
	s := &Server{log: slog.New(slog.DiscardHandler), tri: newNewsTriage()}
	s.cfg.Complete = func(context.Context, []map[string]any) (string, error) {
		calls++
		return `[{"i":0,"en":"Oil rises","relevant":true}]`, nil
	}
	s.cfg.ModelConfigured = gw.Configured
	raw := json.RawMessage(`{"ok":true,"items":[{"title":"Oil rises"}]}`)
	if got := s.triageNews(context.Background(), "WTICO/USD", "WTI Crude", raw); string(got) != string(raw) {
		t.Fatalf("a failed config read must pass the items through unmarked: %s", got)
	}
	s.tri.wg.Wait()
	if calls != 0 {
		t.Fatalf("a failed config read must start no model call: %d calls", calls)
	}
	// the next request reads a configured model and is triaged, so the failed read set no backoff
	if d := triageOnce(t, s, raw); len(d.Items) != 1 || !d.Items[0].Pending {
		t.Fatalf("the request after a failed config read must be triaged: %+v", d)
	}
	s.tri.wg.Wait()
	if calls != 1 {
		t.Fatalf("the request after a failed config read must call the model once: %d calls", calls)
	}
}

func llmConfigReq(token, remote string) *http.Request {
	r := httptest.NewRequest(http.MethodGet, "http://127.0.0.1:8080/api/v1/runtime/llm-config", nil)
	if token != "" {
		r.Header.Set("Authorization", "Bearer "+token)
	}
	r.RemoteAddr = remote
	return r
}

// The token and loopback refusals answer before the store is read, so they need no database.
func TestLLMConfigRefusesWithoutTokenOrFromANonLoopbackPeer(t *testing.T) {
	srv := New(Config{WorkerToken: "w", IngestToken: "i"}, nil, slog.New(slog.DiscardHandler))
	for _, c := range []struct {
		token, remote string
		want          int
	}{
		{"", "127.0.0.1:5000", http.StatusUnauthorized},
		{"i", "127.0.0.1:5000", http.StatusUnauthorized},
		{"wrong", "[::1]:5000", http.StatusUnauthorized},
		{"w", "192.0.2.1:5000", http.StatusNotFound},
		{"w", "10.0.0.2:5000", http.StatusNotFound},
		{"w", "not-an-address", http.StatusNotFound},
	} {
		rec := httptest.NewRecorder()
		srv.Handler().ServeHTTP(rec, llmConfigReq(c.token, c.remote))
		if rec.Code != c.want || strings.Contains(rec.Body.String(), "apiKey") {
			t.Errorf("token %q from %s: got %d %s, want %d", c.token, c.remote, rec.Code, rec.Body, c.want)
		}
	}
	// a proxy on the host, such as the console's rewrite, connects from loopback but adds forwarding headers
	for _, h := range []string{"X-Forwarded-For", "X-Forwarded-Host", "Forwarded"} {
		r := llmConfigReq("w", "127.0.0.1:5000")
		r.Header.Set(h, "127.0.0.1:8080") // an allowed host, so only the route's own check refuses
		rec := httptest.NewRecorder()
		srv.Handler().ServeHTTP(rec, r)
		if rec.Code != http.StatusNotFound {
			t.Errorf("%s: got %d, want 404", h, rec.Code)
		}
	}
}

func TestLLMConfigReturnsOnlyTheProviderFields(t *testing.T) {
	pool := testutil.Pool(t)
	var log bytes.Buffer
	srv := New(Config{WorkerToken: "w", IngestToken: "i"}, queue.New(pool), slog.New(slog.NewTextHandler(&log, nil)))
	get := func() (http.Header, map[string]any) {
		t.Helper()
		rec := httptest.NewRecorder()
		srv.Handler().ServeHTTP(rec, llmConfigReq("w", "127.0.0.1:5000"))
		var out map[string]any
		if rec.Code != http.StatusOK || json.Unmarshal(rec.Body.Bytes(), &out) != nil {
			t.Fatalf("got %d %s", rec.Code, rec.Body)
		}
		if keys := slices.Sorted(maps.Keys(out)); !slices.Equal(keys, []string{"apiKey", "baseUrl", "configured", "model"}) {
			t.Fatalf("the route must return exactly the four provider fields: %v", keys)
		}
		return rec.Header(), out
	}

	h, out := get()
	if h.Get("Cache-Control") != "no-store" || out["configured"] != false || out["apiKey"] != "" || out["baseUrl"] != "" || out["model"] != "" {
		t.Fatalf("unconfigured: %v %v", h, out)
	}
	if _, _, err := settings.Write(context.Background(), pool, settings.FromAPI, map[string]any{
		"OPENAI_API_KEY": "sk-test-SECRET", "ANTHROPIC_API_KEY": "sk-test-ANTHROPIC", "provider": "openai", "model": "gpt-test",
	}, nil); err != nil {
		t.Fatal(err)
	}
	h, out = get()
	if h.Get("Cache-Control") != "no-store" || out["configured"] != true || out["apiKey"] != "sk-test-SECRET" || out["baseUrl"] != settings.OpenAIBaseURL || out["model"] != "gpt-test" {
		t.Fatalf("configured: %v %v", h, out)
	}
	if strings.Contains(log.String(), "SECRET") || strings.Contains(log.String(), "ANTHROPIC") {
		t.Fatalf("the route must not log the response: %q", log.String())
	}
}
