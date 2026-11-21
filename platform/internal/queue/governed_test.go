package queue

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
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
		{"old snapshot is returned as stored", `{"strategy": {"name":"old"}}`, ``, `{"strategy": {"name":"old"}}`},
		{"frozen JSON null is no strategy", `{"strategy": {"name":"old"}}`, `null`, `{"strategy": {"name":"old"}}`},
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
