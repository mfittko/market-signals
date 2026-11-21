package api

import (
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/mfittko/market-signals/platform/internal/queue"
	"github.com/mfittko/market-signals/platform/internal/settings"
	"github.com/mfittko/market-signals/platform/internal/testutil"
)

func settingsServer(t *testing.T) string {
	t.Helper()
	srv := New(Config{WorkerToken: "w", IngestToken: "i", OperatorToken: "op"}, queue.New(testutil.Pool(t)), slog.New(slog.NewTextHandler(io.Discard, nil)))
	hs := httptest.NewServer(srv.Handler())
	t.Cleanup(hs.Close)
	return hs.URL + "/api/v1"
}

func TestSettingsRouteMasksSecretsAndRefusesPaths(t *testing.T) {
	api := settingsServer(t)
	code, out := call(t, "PATCH", api+"/settings", "", `{"OPENAI_API_KEY":"sk-fake","GNEWS_KEY":"g-fake","port":8787}`, nil)
	if code != http.StatusOK || out["revision"] != float64(1) {
		t.Fatal(code, out)
	}
	code, out = call(t, "GET", api+"/settings", "", "", nil)
	s, _ := out["settings"].(map[string]any)
	if code != http.StatusOK || s["OPENAI_API_KEY"] != settings.Mask || s["GNEWS_KEY"] != settings.Mask || s["port"] != float64(8787) {
		t.Fatal(code, out)
	}
	for _, body := range []string{`{"claudeBin":"claude"}`, `{"model":"/bin/sh"}`, `{"port":"80"}`, `{"nope":1}`} {
		if code, out = call(t, "PATCH", api+"/settings", "", body, nil); code != http.StatusBadRequest || out["code"] != "invalid_setting" {
			t.Fatal(body, code, out)
		}
	}
	code, out = call(t, "PATCH", api+"/settings", "", `{"bot":{"bots":{"XAU/USD|H1":{"enabled":true}}}}`, nil)
	if code != http.StatusConflict || out["code"] != "bot_needs_pair" {
		t.Fatal(code, out)
	}
}

func TestJobOwnerFlagsOnlyThroughTheOperatorRoute(t *testing.T) {
	api := settingsServer(t)
	if code, out := call(t, "PATCH", api+"/settings", "", `{"jobOwner.bot":"go"}`, nil); code != http.StatusBadRequest {
		t.Fatal("settings route wrote a job owner flag:", code, out)
	}
	if code, _ := call(t, "PUT", api+"/operator/job-owners", "", `{"bot":"go"}`, nil); code != http.StatusUnauthorized {
		t.Fatal("operator route without token:", code)
	}
	if code, _ := call(t, "GET", api+"/operator/job-owners", "wrong", "", nil); code != http.StatusUnauthorized {
		t.Fatal("operator read with a wrong token:", code)
	}
	if code, out := call(t, "PUT", api+"/operator/job-owners", "op", `{"weather":"go"}`, nil); code != http.StatusBadRequest {
		t.Fatal("unknown job kind:", code, out)
	}
	code, out := call(t, "PUT", api+"/operator/job-owners", "op", `{"bot":"go"}`, nil)
	owners, _ := out["owners"].(map[string]any)
	if code != http.StatusOK || owners["bot"] != "go" || owners["news"] != "node" {
		t.Fatal(code, out)
	}
	code, out = call(t, "GET", api+"/operator/job-owners", "op", "", nil)
	if owners, _ = out["owners"].(map[string]any); code != http.StatusOK || owners["bot"] != "go" {
		t.Fatal(code, out)
	}
	_, out = call(t, "GET", api+"/settings", "", "", nil)
	if s, _ := out["settings"].(map[string]any); len(s) != 0 {
		t.Fatal("job owner flag visible on the settings route:", out)
	}
}
