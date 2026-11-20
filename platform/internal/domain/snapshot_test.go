package domain

import "testing"

func TestSnapshotLeavesOutAbsentFields(t *testing.T) {
	m := Snapshot(SnapshotFields{Instrument: "WTICO/USD", Granularity: "M5", Event: "tripwire", Close: 1.5, EngineStrategy: map[string]any{"name": "s"}})
	if len(m) != 5 || m["close"] != 1.5 || m["engineStrategy"] == nil || m["event"] != "tripwire" {
		t.Fatalf("%v", m)
	}
	if _, has := m["flip"]; has {
		t.Fatal("a nil field must be left out")
	}
}

func TestEncodeSnapshotKeepsSymbols(t *testing.T) {
	b, err := EncodeSnapshot(map[string]any{"prompt": "close > EMA & ADX < 25"})
	if err != nil || string(b) != `{"prompt":"close > EMA & ADX < 25"}` {
		t.Fatalf("%s %v", b, err)
	}
}
