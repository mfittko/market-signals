package tools

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/mfittko/market-signals/platform/internal/queue"
)

// A long strategy prompt once pushed a snapshot past the tool cap, and the cut
// left invalid JSON that made every check for that instrument fail.
func TestSnapshotToolReturnsValidJSONForALongStrategy(t *testing.T) {
	payload, _ := json.Marshal(map[string]any{"strategy": map[string]any{"prompt": strings.Repeat("rule ", 3000)}})
	if len(payload) <= MaxOutputBytes {
		t.Fatal("test payload must exceed the ordinary tool cap")
	}
	tc := &queue.ToolContext{}
	tc.Snapshot.Payload = payload
	out, err := Exec(context.Background(), nil, nil, 0, 0, tc, "get_snapshot", nil)
	if err != nil {
		t.Fatal(err)
	}
	if !json.Valid([]byte(out)) {
		t.Fatalf("snapshot came back cut: %d bytes", len(out))
	}
}

// A snapshot at the ingest cap full of <, > and & must come back byte-for-byte, because
// HTML escaping would grow it past the cap and cut it into invalid JSON.
func TestSnapshotToolDoesNotEscapeHTML(t *testing.T) {
	prompt := strings.Repeat("close > EMA & ", 1<<20)
	payload := []byte(`{"strategy":{"prompt":"` + prompt[:MaxSnapshotBytes-40] + `"}}`)
	tc := &queue.ToolContext{}
	tc.Snapshot.Payload = payload
	out, err := Exec(context.Background(), nil, nil, 0, 0, tc, "get_snapshot", nil)
	if err != nil {
		t.Fatal(err)
	}
	if out != string(payload) {
		t.Fatalf("snapshot changed on read: %d bytes in, %d out, valid %v", len(payload), len(out), json.Valid([]byte(out)))
	}
}
