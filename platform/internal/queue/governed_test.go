package queue

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"
)

func TestIngestCapCountsTheClaimedPayloadOfAnAgentWithoutAConsoleStrategy(t *testing.T) {
	s, ctx := fresh(t)
	must(t, s.UpsertAgent(ctx, agent("a1")))
	pre, suf := `{"engineStrategy":{"dbVersion":3,"name":"e","prompt":"`, `","version":"v"}}`
	p := json.RawMessage(pre + strings.Repeat("x", MaxSnapshotBytes-20-len(pre)-len(suf)) + suf)
	// the claim adds the strategy key and a prompt-less engineStrategy reference, more than the key alone
	if len(p)+len(`,"strategy":`) > MaxSnapshotBytes || len(governed(p, nil)) <= MaxSnapshotBytes {
		t.Fatalf("payload %d, claimed %d: the case must pass a key-only estimate and exceed the cap when claimed", len(p), len(governed(p, nil)))
	}
	_, err := s.Ingest(ctx, IngestInput{IdemKey: "near-cap", Instrument: "WTICO/USD", Granularity: "M5", Event: "flip", Source: "engine", Payload: p})
	if !errors.Is(err, ErrSnapshotTooLarge) {
		t.Fatalf("a claimed payload over the cap must be refused: %v", err)
	}
}

func TestGovernedPicksTheFrozenStrategyThenTheEngines(t *testing.T) {
	cases := []struct{ name, payload, frozen, want string }{
		{"frozen wins, engine kept without prompt",
			`{"engineStrategy":{"name":"e","prompt":"p"}}`, `{"name":"c","version":1,"prompt":"q"}`,
			`{"engineStrategy":{"name":"e"},"strategy":{"name":"c","prompt":"q","version":1}}`},
		{"engine governs without a frozen strategy",
			`{"engineStrategy":{"name":"e","prompt":"p"}}`, ``,
			`{"engineStrategy":{"name":"e"},"strategy":{"name":"e","prompt":"p"}}`},
		{"old snapshot is re-encoded compactly", `{"strategy": {"name":"old"}}`, ``, `{"strategy":{"name":"old"}}`},
		{"frozen JSON null is no strategy", `{"strategy": {"name":"old"}}`, `null`, `{"strategy":{"name":"old"}}`},
		{"spaced jsonb text without a strategy is compacted", `{"close": 100.5, "flip": {"signal": "buy"}, "bars": [1, 2]}`, ``,
			`{"bars":[1,2],"close":100.5,"flip":{"signal":"buy"}}`},
		{"non-object payload passes through", `[1,2]`, `{"name":"c"}`, `[1,2]`},
		{"malformed payload passes through", `{`, `{"name":"c"}`, `{`},
		{"engineStrategy of the wrong type is ignored", `{"engineStrategy":"e"}`, ``, `{"engineStrategy":"e"}`},
	}
	for _, c := range cases {
		var frozen []byte
		if c.frozen != "" {
			frozen = []byte(c.frozen)
		}
		if got := string(governed([]byte(c.payload), frozen)); got != c.want {
			t.Errorf("%s: got %s, want %s", c.name, got, c.want)
		}
	}
}

// A run freezes only an active, unarchived version of the agent's strategy. Without one the engine's strategy governs.
func TestIngestFreezesOnlyAnActiveUnarchivedStrategyVersion(t *testing.T) {
	cases := []struct {
		name     string
		versions [][2]bool // per version 1..n: active, archived
		want     string    // the frozen prompt, empty when the engine's strategy governs
	}{
		{"a name with drafts only leaves the engine's strategy", [][2]bool{{false, false}, {false, false}}, ""},
		{"the active version wins over a newer inactive draft", [][2]bool{{true, false}, {false, false}}, "p1"},
		{"an archived active version next to a draft leaves the engine's strategy", [][2]bool{{true, true}, {false, false}}, ""},
	}
	for i, c := range cases {
		s, ctx := fresh(t)
		name := fmt.Sprintf("Draft-%d-%d", time.Now().UnixNano(), i)
		for v, f := range c.versions {
			if _, err := testPool.Exec(ctx, `INSERT INTO strategies (name,version,prompt,created_by,created_at,active,archived,dedicated) VALUES ($1,$2,$3,'test',now(),$4,$5,false)`,
				name, v+1, fmt.Sprintf("p%d", v+1), f[0], f[1]); err != nil {
				t.Fatal(err)
			}
		}
		// assign the name directly: UpsertAgent refuses a name whose versions are all archived
		must(t, s.UpsertAgent(ctx, agent("a1")))
		if _, err := testPool.Exec(ctx, `UPDATE agents SET strategy_name=$1 WHERE id='a1'`, name); err != nil {
			t.Fatal(err)
		}
		r := ingest(t, s, ctx)
		if len(r.Runs) != 1 {
			t.Fatalf("%s: runs %+v", c.name, r.Runs)
		}
		var got *string
		must(t, testPool.QueryRow(ctx, `SELECT strategy->>'prompt' FROM runs WHERE id=$1`, r.Runs[0].RunID).Scan(&got))
		if (got == nil) != (c.want == "") || (got != nil && *got != c.want) {
			t.Errorf("%s: frozen prompt %v, want %q", c.name, got, c.want)
		}
	}
}
