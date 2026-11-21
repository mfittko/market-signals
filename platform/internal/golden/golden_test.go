package golden

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestCloseAppliesTheFormatTolerance(t *testing.T) {
	if !Close(100, 100*(1+1e-10)) {
		t.Error("a 1e-10 relative difference must pass")
	}
	if Close(100, 100*(1+1e-8)) {
		t.Error("a 1e-8 relative difference must fail")
	}
	if !Close(0, 1e-13) || Close(0, 1e-11) {
		t.Error("near zero the absolute tolerance is 1e-12")
	}
}

func TestDecodeRejectsAnotherVersionOrArea(t *testing.T) {
	ok := `{"version":1,"area":"monitor","cases":[{"name":"a","input":{},"expected":{}}]}`
	if _, err := Decode([]byte(ok), "monitor"); err != nil {
		t.Fatal(err)
	}
	for _, bad := range []string{
		strings.Replace(ok, `"version":1`, `"version":2`, 1),
		strings.Replace(ok, `"monitor"`, `"portfolio"`, 1),
		`{"version":1,"area":"monitor","cases":[]}`,
	} {
		if _, err := Decode([]byte(bad), "monitor"); err == nil {
			t.Errorf("accepted %s", bad)
		}
	}
}

func TestMatchNamesThePathOfTheFirstDifference(t *testing.T) {
	got := map[string]any{"stop": 98.0, "fired": []string{"impulse"}}
	if err := Match(got, json.RawMessage(`{"stop":98.0000000001,"fired":["impulse"]}`)); err != nil {
		t.Fatal(err)
	}
	for want, path := range map[string]string{
		`{"stop":98.5,"fired":["impulse"]}`:           "$.stop",
		`{"stop":98,"fired":["flip"]}`:                "$.fired[0]",
		`{"stop":98}`:                                 "$:",
		`{"stop":98,"fired":["impulse"],"exit":null}`: "$:",
		`{"stop":98,"fired":["impulse","impulse"]}`:   "$.fired:",
	} {
		err := Match(got, json.RawMessage(want))
		if err == nil || !strings.HasPrefix(err.Error(), path) {
			t.Errorf("%s: got %v, want an error at %s", want, err, path)
		}
	}
}
