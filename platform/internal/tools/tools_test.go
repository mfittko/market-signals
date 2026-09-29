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
