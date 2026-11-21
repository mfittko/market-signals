package settings_test

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/mfittko/market-signals/platform/internal/settings"
	"github.com/mfittko/market-signals/platform/internal/testutil"
)

// writeFile writes a fake settings.json; no test reads the real one.
func writeFile(t *testing.T, path string, v map[string]any) {
	t.Helper()
	b, _ := json.Marshal(v)
	if err := os.WriteFile(path, b, 0o600); err != nil {
		t.Fatal(err)
	}
}

func load(t *testing.T, pool *pgxpool.Pool) settings.Snapshot {
	t.Helper()
	snap, err := settings.Load(context.Background(), pool)
	if err != nil {
		t.Fatal(err)
	}
	return snap
}

func revisionKeys(t *testing.T, pool *pgxpool.Pool) [][]string {
	t.Helper()
	rows, err := pool.Query(context.Background(), `SELECT keys FROM settings_revisions ORDER BY revision`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var out [][]string
	for rows.Next() {
		var k []string
		if err := rows.Scan(&k); err != nil {
			t.Fatal(err)
		}
		out = append(out, k)
	}
	return out
}

func fileSettings() map[string]any {
	return map[string]any{
		"provider": "openai", "OPENAI_API_KEY": "sk-fake-1", "port": 8787, "piBin": "/fake/bin/pi",
		"watchers": "WTICO/USD|M5", "keepFresh": "1",
		"bot":          map[string]any{"bots": map[string]any{"WTICO/USD|M5": map[string]any{"enabled": true, "strategyName": "flip"}}},
		"watcherOwner": "node", // a retired key: skipped, never stored
	}
}

func TestImportIsIdempotentAndImportsOnlyChanges(t *testing.T) {
	pool := testutil.Pool(t)
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "settings.json")
	file := fileSettings()
	writeFile(t, path, file)

	first, err := settings.Import(ctx, pool, path)
	if err != nil {
		t.Fatal(err)
	}
	if first.Revision != 1 || len(first.Changed) != 7 || !slices.Equal(first.Skipped, []string{"watcherOwner: unknown settings key"}) {
		t.Fatalf("first import: %+v", first)
	}
	before := load(t, pool)
	if before.Values["piBin"] != "/fake/bin/pi" || before.Values["port"] != float64(8787) {
		t.Fatalf("stored: %v", before.Values)
	}

	again, err := settings.Import(ctx, pool, path)
	if err != nil {
		t.Fatal(err)
	}
	after := load(t, pool)
	if again.Revision != 1 || len(again.Changed) != 0 || after.Revision != 1 {
		t.Fatalf("second import of the same file: %+v, revision %d", again, after.Revision)
	}
	if b1, _ := json.Marshal(before.Values); string(b1) != string(mustJSON(after.Values)) {
		t.Fatalf("rows changed: %s", mustJSON(after.Values))
	}
	if got := string(mustJSON(again)); !strings.Contains(got, `"changed":[]`) || !strings.Contains(got, `"notes":[]`) {
		t.Fatalf("empty lists must marshal as arrays: %s", got)
	}

	// One key changes and one disappears: the next revision names exactly those two.
	file["OPENAI_API_KEY"] = "sk-fake-2"
	delete(file, "keepFresh")
	writeFile(t, path, file)
	third, err := settings.Import(ctx, pool, path)
	if err != nil {
		t.Fatal(err)
	}
	if third.Revision != 2 || !slices.Equal(third.Changed, []string{"OPENAI_API_KEY", "keepFresh"}) {
		t.Fatalf("delta import: %+v", third)
	}
	keys := revisionKeys(t, pool)
	if len(keys) != 2 || !slices.Equal(keys[1], []string{"OPENAI_API_KEY", "keepFresh"}) {
		t.Fatalf("revisions: %v", keys)
	}
	if v := load(t, pool).Values; v["OPENAI_API_KEY"] != "sk-fake-2" || v["keepFresh"] != nil {
		t.Fatalf("stored after delta: %v", v)
	}
}

func mustJSON(v any) []byte { b, _ := json.Marshal(v); return b }

func TestImportRefusesAFileThatIsNotAJSONObject(t *testing.T) {
	pool := testutil.Pool(t)
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "settings.json")
	writeFile(t, path, fileSettings())
	if _, err := settings.Import(ctx, pool, path); err != nil {
		t.Fatal(err)
	}
	before := load(t, pool)
	// null decodes to a nil map; without the guard every stored key would be deleted.
	for _, body := range []string{"null", "[]", "{"} {
		if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
		if _, err := settings.Import(ctx, pool, path); err == nil || !strings.Contains(err.Error(), "is not a JSON object") {
			t.Fatalf("%s: got %v", body, err)
		}
		after := load(t, pool)
		if after.Revision != before.Revision || string(mustJSON(after.Values)) != string(mustJSON(before.Values)) {
			t.Fatalf("%s: store changed: revision %d, %s", body, after.Revision, mustJSON(after.Values))
		}
	}
}

func TestImportReportsAWideFileMode(t *testing.T) {
	pool := testutil.Pool(t)
	path := filepath.Join(t.TempDir(), "settings.json")
	writeFile(t, path, map[string]any{"port": 1})
	if err := os.Chmod(path, 0o644); err != nil {
		t.Fatal(err)
	}
	rep, err := settings.Import(context.Background(), pool, path)
	if err != nil || len(rep.Notes) != 1 {
		t.Fatalf("%+v %v", rep, err)
	}
}

func TestRefusedWriteChangesNothing(t *testing.T) {
	pool := testutil.Pool(t)
	ctx := context.Background()
	if _, _, err := settings.Write(ctx, pool, settings.FromAPI, map[string]any{"port": float64(8787)}); err != nil {
		t.Fatal(err)
	}
	for _, patch := range []map[string]any{
		{"port": float64(9000), "unknownKey": "x"}, // unknown key
		{"port": "9000"},                       // wrong type
		{"port": float64(9000), "piBin": "pi"}, // path key over HTTP
		{"model": "/usr/local/bin/model"},      // path value over HTTP
		{"jobOwner.bot": "go"},                 // operator-only key
	} {
		if _, _, err := settings.Write(ctx, pool, settings.FromAPI, patch); !errors.Is(err, settings.ErrInvalid) {
			t.Fatalf("%v: got %v, want ErrInvalid", patch, err)
		}
	}
	snap := load(t, pool)
	if snap.Revision != 1 || snap.Values["port"] != float64(8787) || len(snap.Values) != 1 {
		t.Fatalf("state changed: %+v", snap)
	}
}

func TestMaskedSecretKeepsStoredValue(t *testing.T) {
	pool := testutil.Pool(t)
	ctx := context.Background()
	if _, _, err := settings.Write(ctx, pool, settings.FromAPI, map[string]any{"OPENAI_API_KEY": "sk-fake"}); err != nil {
		t.Fatal(err)
	}
	snap, changed, err := settings.Write(ctx, pool, settings.FromAPI, map[string]any{"OPENAI_API_KEY": settings.Mask})
	if err != nil || len(changed) != 0 || snap.Revision != 1 || snap.Values["OPENAI_API_KEY"] != "sk-fake" {
		t.Fatalf("%+v %v %v", snap, changed, err)
	}
}

func TestBotWithoutWatcherPairIsRefusedInTheTransaction(t *testing.T) {
	pool := testutil.Pool(t)
	ctx := context.Background()
	if _, _, err := settings.Write(ctx, pool, settings.FromAPI, map[string]any{"watchers": "WTICO/USD|M5"}); err != nil {
		t.Fatal(err)
	}
	enable := map[string]any{"bot": map[string]any{"bots": map[string]any{"XAU/USD|H1": map[string]any{"enabled": true}}}}
	_, _, err := settings.Write(ctx, pool, settings.FromAPI, enable)
	var pe settings.PairError
	if !errors.As(err, &pe) || !slices.Equal(pe.Pairs, []string{"XAU/USD|H1"}) {
		t.Fatalf("got %v", err)
	}
	if snap := load(t, pool); snap.Revision != 1 || snap.Values["bot"] != nil {
		t.Fatalf("state changed: %+v", snap)
	}
	// Dropping the pair under an enabled bot is refused the same way.
	enable["watchers"] = "WTICO/USD|M5,XAU/USD|H1"
	if _, _, err := settings.Write(ctx, pool, settings.FromAPI, enable); err != nil {
		t.Fatal(err)
	}
	if _, _, err := settings.Write(ctx, pool, settings.FromAPI, map[string]any{"watchers": "WTICO/USD|M5"}); !errors.As(err, &pe) {
		t.Fatalf("removing the pair: got %v", err)
	}
}

func TestInstrumentChangeUnderAFallbackWatchedBotIsRefused(t *testing.T) {
	pool := testutil.Pool(t)
	ctx := context.Background()
	// No watchers: the engine watches instrument|granularity, so the bot's pair is XAU/USD|H1.
	seed := map[string]any{
		"instrument": "XAU/USD", "granularity": "H1",
		"bot": map[string]any{"bots": map[string]any{"XAU/USD|H1": map[string]any{"enabled": true}}},
	}
	if _, _, err := settings.Write(ctx, pool, settings.FromAPI, seed); err != nil {
		t.Fatal(err)
	}
	for _, patch := range []map[string]any{{"instrument": "BCO/USD"}, {"granularity": "M5"}} {
		var pe settings.PairError
		if _, _, err := settings.Write(ctx, pool, settings.FromAPI, patch); !errors.As(err, &pe) || !slices.Equal(pe.Pairs, []string{"XAU/USD|H1"}) {
			t.Fatalf("%v: got %v", patch, err)
		}
	}
	if snap := load(t, pool); snap.Revision != 1 || snap.Values["instrument"] != "XAU/USD" || snap.Values["granularity"] != "H1" {
		t.Fatalf("state changed: %+v", snap)
	}
}

func TestImportKeepsTheStoredValueOfARefusedKey(t *testing.T) {
	pool := testutil.Pool(t)
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "settings.json")
	writeFile(t, path, map[string]any{"port": 8787})
	if _, err := settings.Import(ctx, pool, path); err != nil {
		t.Fatal(err)
	}
	writeFile(t, path, map[string]any{"port": "abc"})
	rep, err := settings.Import(ctx, pool, path)
	if err != nil || len(rep.Skipped) != 1 || !strings.HasPrefix(rep.Skipped[0], "port:") {
		t.Fatalf("%+v %v", rep, err)
	}
	if v := load(t, pool).Values["port"]; v != float64(8787) {
		t.Fatalf("refused key lost its stored value: %v", v)
	}
}

func TestImportKeepsJobOwnerFlags(t *testing.T) {
	pool := testutil.Pool(t)
	ctx := context.Background()
	if _, _, err := settings.Write(ctx, pool, settings.FromOperator, map[string]any{"jobOwner.news": "go"}); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "settings.json")
	writeFile(t, path, map[string]any{"port": 1, "jobOwner.news": "node"})
	rep, err := settings.Import(ctx, pool, path)
	if err != nil || len(rep.Skipped) != 1 {
		t.Fatalf("%+v %v", rep, err)
	}
	if v := load(t, pool).Values["jobOwner.news"]; v != "go" {
		t.Fatalf("job owner flag changed by the import: %v", v)
	}
}
