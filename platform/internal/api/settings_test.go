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
	code, out = call(t, "PATCH", api+"/settings", "", `{"baseRevision":1,"bot":{"bots":{"XAU/USD|H1":{"enabled":true}}}}`, nil)
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

func TestSettingsWriteNeedsTheCurrentBaseRevision(t *testing.T) {
	api := settingsServer(t)
	// Only a write at revision 0 may omit the base.
	if code, out := call(t, "PATCH", api+"/settings", "", `{"port":8787}`, nil); code != http.StatusOK || out["revision"] != float64(1) {
		t.Fatal(code, out)
	}
	if code, out := call(t, "PATCH", api+"/settings", "", `{"port":8788}`, nil); code != http.StatusBadRequest || out["code"] != "base_revision_required" {
		t.Fatal(code, out)
	}
	for _, base := range []string{`"4"`, `1.5`, `-1`, `null`, `1e19`, `9007199254740992`, `9223372036854775807`, `9223372036854775808`} {
		body := `{"baseRevision":` + base + `,"port":8788}`
		if code, out := call(t, "PATCH", api+"/settings", "", body, nil); code != http.StatusBadRequest || out["code"] != "invalid_setting" {
			t.Fatal(body, code, out)
		}
	}
	if code, out := call(t, "PATCH", api+"/settings", "", `{"baseRevision":1,"port":8789}`, nil); code != http.StatusOK || out["revision"] != float64(2) {
		t.Fatal(code, out)
	}
	// Any base other than revision 2 is now stale and stores nothing, including a patch that changes nothing.
	for _, body := range []string{`{"baseRevision":1,"port":9000}`, `{"baseRevision":1,"port":8789}`,
		`{"baseRevision":0,"port":9000}`, `{"baseRevision":4,"port":9000}`, `{"baseRevision":9007199254740991,"port":9000}`} {
		code, out := call(t, "PATCH", api+"/settings", "", body, nil)
		if code != http.StatusConflict || out["code"] != "stale_base_revision" || out["currentRevision"] != float64(2) {
			t.Fatal(body, code, out)
		}
	}
	_, out := call(t, "GET", api+"/settings", "", "", nil)
	if s, _ := out["settings"].(map[string]any); out["revision"] != float64(2) || s["port"] != float64(8789) {
		t.Fatal("stale write changed the settings:", out)
	}
	if code, out := call(t, "PATCH", api+"/settings", "", `{"baseRevision":2,"port":9000}`, nil); code != http.StatusOK || out["revision"] != float64(3) {
		t.Fatal(code, out)
	}
	// The operator job-owner route writes without a base above revision 0 and still raises the revision.
	if code, out := call(t, "PUT", api+"/operator/job-owners", "op", `{"bot":"go"}`, nil); code != http.StatusOK || out["revision"] != float64(4) {
		t.Fatal(code, out)
	}
	code, out := call(t, "PATCH", api+"/settings", "", `{"baseRevision":3,"port":9001}`, nil)
	if code != http.StatusConflict || out["code"] != "stale_base_revision" || out["currentRevision"] != float64(4) {
		t.Fatal(code, out)
	}
}
