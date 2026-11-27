package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"maps"
	"math"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/mfittko/market-signals/platform/internal/queue"
	"github.com/mfittko/market-signals/platform/internal/runtime"
	"github.com/mfittko/market-signals/platform/internal/settings"
	"github.com/mfittko/market-signals/platform/internal/spend"
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
	return workerReq(http.MethodGet, "/api/v1/runtime/llm-config", "", token, remote)
}

func workerReq(method, path, body, token, remote string) *http.Request {
	r := httptest.NewRequest(method, "http://127.0.0.1:8080"+path, strings.NewReader(body))
	if token != "" {
		r.Header.Set("Authorization", "Bearer "+token)
	}
	r.RemoteAddr = remote
	return r
}

const spendBody = `{"callSite":"agent","provider":"http://p/v1/chat/completions","model":"m","promptTokens":10,"completionTokens":5}`

// The token and loopback refusals answer before the store is read, so they need no database.
func TestWorkerConfigAndSpendRoutesRefuseWithoutTokenOrFromANonLoopbackPeer(t *testing.T) {
	srv := New(Config{WorkerToken: "w", IngestToken: "i"}, nil, slog.New(slog.DiscardHandler))
	for _, route := range []struct{ method, path, body string }{
		{http.MethodGet, "/api/v1/runtime/llm-config", ""},
		{http.MethodPost, "/api/v1/runtime/spend", spendBody},
	} {
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
			srv.Handler().ServeHTTP(rec, workerReq(route.method, route.path, route.body, c.token, c.remote))
			if rec.Code != c.want || strings.Contains(rec.Body.String(), "apiKey") {
				t.Errorf("%s token %q from %s: got %d %s, want %d", route.path, c.token, c.remote, rec.Code, rec.Body, c.want)
			}
		}
		// a proxy on the host, such as the console's rewrite, connects from loopback but adds forwarding headers
		for _, h := range []string{"X-Forwarded-For", "X-Forwarded-Host", "Forwarded"} {
			r := workerReq(route.method, route.path, route.body, "w", "127.0.0.1:5000")
			r.Header.Set(h, "127.0.0.1:8080") // an allowed host, so only the route's own check refuses
			rec := httptest.NewRecorder()
			srv.Handler().ServeHTTP(rec, r)
			if rec.Code != http.StatusNotFound {
				t.Errorf("%s %s: got %d, want 404", route.path, h, rec.Code)
			}
		}
	}
}

// Validation answers before the store is used, so it needs no database.
func TestSpendRouteRefusesAnInvalidBody(t *testing.T) {
	srv := New(Config{WorkerToken: "w", IngestToken: "i"}, nil, slog.New(slog.DiscardHandler))
	for _, body := range []string{
		`not json`,
		`{"callSite":"","model":"glm-5"}`,
		`{"callSite":" ","model":"m"}`,
		`{"callSite":"  ","model":"glm-5"}`,
		`{"callSite":" agent","model":"glm-5"}`,
		`{"callSite":"agent ","model":"glm-5"}`,
		`{"callSite":"agent","model":""}`,
		`{"callSite":"agent","model":"  "}`,
		`{"callSite":"agent","model":" glm-5"}`,
		`{"callSite":"agent","model":"glm-5 "}`,
		`{"callSite":"agent","model":"m","promptTokens":-1}`,
		`{"callSite":"agent","model":"m","completionTokens":-1}`,
	} {
		rec := httptest.NewRecorder()
		srv.Handler().ServeHTTP(rec, workerReq(http.MethodPost, "/api/v1/runtime/spend", body, "w", "127.0.0.1:5000"))
		if rec.Code != http.StatusBadRequest {
			t.Errorf("%s: got %d, want 400", body, rec.Code)
		}
	}
}

func TestSpendRouteStoresAPricedRow(t *testing.T) {
	pool := testutil.Pool(t)
	srv := New(Config{WorkerToken: "w", IngestToken: "i"}, queue.New(pool), slog.New(slog.DiscardHandler))
	// the body's cost field is ignored and run 99 names no run, so the row has a NULL run id
	body := `{"callSite":"agent","provider":"http://p/v1/chat/completions","model":"glm-5","promptTokens":1000000,"completionTokens":1000000,"runId":99,"costUsd":0}`
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, workerReq(http.MethodPost, "/api/v1/runtime/spend", body, "w", "127.0.0.1:5000"))
	if rec.Code != http.StatusNoContent {
		t.Fatalf("got %d %s", rec.Code, rec.Body)
	}
	var site, as string
	var cost float64
	var noRun bool
	if err := pool.QueryRow(context.Background(), `SELECT call_site, priced_as, cost_usd, run_id IS NULL FROM model_spend`).Scan(&site, &as, &cost, &noRun); err != nil {
		t.Fatal(err)
	}
	if site != "agent" || as != "glm-5" || math.Abs(cost-4.2) > 1e-9 || !noRun {
		t.Fatalf("got %s %s %v %v", site, as, cost, noRun)
	}
}

// The api's own gateway (grill, autogrill, news triage) reads the cap through CapAwareLLM.
func TestAPISourceRefusesAtTheCap(t *testing.T) {
	var hits atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { hits.Add(1) }))
	defer provider.Close()
	prevLLM, prevToday := llmSettings, spendToday
	t.Cleanup(func() { llmSettings, spendToday = prevLLM, prevToday })
	llmSettings = func(context.Context, *pgxpool.Pool) (string, string, string, bool, error) {
		return provider.URL, "sk-test-fake", "m", true, nil
	}
	spent := 4.99
	spendToday = func(context.Context, *pgxpool.Pool, time.Time) (float64, float64, error) { return spent, 5, nil }
	cfg, err := CapAwareLLM(context.Background(), nil)
	if err != nil || cfg.CapReached || !cfg.Configured {
		t.Fatalf("below the cap: %+v %v", cfg, err)
	}
	spent = 5
	gw := runtime.NewGateway(func(ctx context.Context) (runtime.ProviderConfig, error) { return CapAwareLLM(ctx, nil) }, nil)
	gw.Record = func(context.Context, runtime.SpendCall) error {
		t.Error("a refused call must not be recorded")
		return nil
	}
	if _, err := (&runtime.LLM{GW: gw}).Complete(runtime.WithCall(context.Background(), "coach", 0), nil); !runtime.IsCapReached(err) || hits.Load() != 0 {
		t.Fatalf("at the cap: %v, %d requests", err, hits.Load())
	}
	// a failed spend read fails the config read
	spendToday = func(context.Context, *pgxpool.Pool, time.Time) (float64, float64, error) {
		return 0, 0, errors.New("db down")
	}
	if _, err := CapAwareLLM(context.Background(), nil); err == nil {
		t.Fatal("a failed spend read must fail the config read")
	}
}

func TestNewsCallSites(t *testing.T) {
	s, link, _ := summaryFixture(t, http.StatusOK, articlePage, func() (string, error) { return "**Oil up.**", nil })
	var sites []string
	inner := s.cfg.Complete
	s.cfg.Complete = func(ctx context.Context, msgs []map[string]any) (string, error) {
		site, _ := runtime.CallFrom(ctx)
		sites = append(sites, site)
		return inner(ctx, msgs)
	}
	if _, err := s.classifyHeadlines(context.Background(), "WTICO/USD", "WTI Crude", []string{"Oil rises"}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.summarize(context.Background(), "WTICO/USD", "WTI Crude", "Oil rises", link); err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(sites, []string{"news_triage", "news_summary"}) {
		t.Fatalf("call sites %v", sites)
	}
}

func TestLLMConfigReturnsTheProviderFieldsAndCapState(t *testing.T) {
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
		if keys := slices.Sorted(maps.Keys(out)); !slices.Equal(keys, []string{"apiKey", "baseUrl", "capReached", "configured", "model"}) {
			t.Fatalf("the route must return exactly the provider fields and capReached: %v", keys)
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
	if out["capReached"] != false {
		t.Fatalf("no spend yet: %v", out)
	}
	// 1M output tokens of gpt-5.4-mini cost $4.50; a second call passes the $5 default cap
	for range 2 {
		if err := spend.Record(context.Background(), pool, spend.Call{CallSite: "agent", Model: "gpt-5.4-mini", CompletionTokens: 1_000_000}); err != nil {
			t.Fatal(err)
		}
	}
	if _, out = get(); out["capReached"] != true {
		t.Fatalf("at the cap: %v", out)
	}
}
