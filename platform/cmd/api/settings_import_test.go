package main

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/mfittko/market-signals/platform/internal/settings"
	"github.com/mfittko/market-signals/platform/internal/testutil"
)

func TestStartupImportResetsTheStoreToTheFileAndKeepsJobOwners(t *testing.T) {
	pool := testutil.Pool(t)
	ctx := context.Background()
	if _, _, err := settings.Write(ctx, pool, settings.FromAPI, map[string]any{"port": 9999, "model": "store-only"}, nil); err != nil {
		t.Fatal(err)
	}
	if _, _, err := settings.Write(ctx, pool, settings.FromOperator, map[string]any{settings.JobOwnerKey("news"): "go"}, nil); err != nil {
		t.Fatal(err)
	}
	// a fake settings file; no test reads the real one
	path := filepath.Join(t.TempDir(), "settings.json")
	b, _ := json.Marshal(map[string]any{"port": 8787, "provider": "openai", "OPENAI_API_KEY": "sk-test-SECRET"})
	if err := os.WriteFile(path, b, 0o600); err != nil {
		t.Fatal(err)
	}
	var log bytes.Buffer
	importSettings(ctx, pool, path, slog.New(slog.NewTextHandler(&log, nil)))

	snap, err := settings.Load(ctx, pool)
	if err != nil {
		t.Fatal(err)
	}
	if snap.Values["port"] != float64(8787) {
		t.Fatalf("a store-only value of a non-LLM key must be overwritten: %v", snap.Values["port"])
	}
	if _, ok := snap.Values["model"]; ok {
		t.Fatalf("a key the file lacks must be deleted: %v", snap.Values["model"])
	}
	if snap.Values[settings.JobOwnerKey("news")] != "go" {
		t.Fatalf("job owner flags stay untouched: %v", snap.Values)
	}
	if !strings.Contains(log.String(), "settings imported") || strings.Contains(log.String(), "SECRET") {
		t.Fatalf("the import report is logged without values: %q", log.String())
	}
	base, _, model, ok := settings.OpenAIProvider(snap.Values)
	if !ok || base != settings.OpenAIBaseURL || model != "gpt-5.4-mini" {
		t.Fatalf("the imported provider resolves: %q %q %v", base, model, ok)
	}
	// the gateway source reads the stored provider
	cfg, err := storeSource(pool)(ctx)
	if err != nil || !cfg.Configured || cfg.APIKey != "sk-test-SECRET" {
		t.Fatalf("store source: configured %v, err %v", cfg.Configured, err)
	}

	log.Reset()
	importSettings(ctx, pool, filepath.Join(t.TempDir(), "missing.json"), slog.New(slog.NewTextHandler(&log, nil)))
	if again, _ := settings.Load(ctx, pool); again.Revision != snap.Revision || !strings.Contains(log.String(), "settings import failed") {
		t.Fatalf("a failed import keeps the stored values: revision %d -> %d, log %q", snap.Revision, again.Revision, log.String())
	}
}
