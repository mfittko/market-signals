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
	"github.com/mfittko/market-signals/platform/internal/settings"
	"github.com/mfittko/market-signals/platform/internal/testutil"
)

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
