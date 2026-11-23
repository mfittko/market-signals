package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRunRefusesAnOutputThatIsAnInput(t *testing.T) {
	dir := t.TempDir()
	spec, data := filepath.Join(dir, "spec.json"), filepath.Join(dir, "export.csv")
	for _, p := range []string{spec, data} {
		if err := os.WriteFile(p, []byte("keep"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	for _, out := range []string{data, spec, filepath.Join(dir, ".", "export.csv")} {
		if err := run(spec, data, out); err == nil || !strings.Contains(err.Error(), "is the input") {
			t.Errorf("--out %s: want a refusal, got %v", out, err)
		}
	}
	for _, p := range []string{spec, data} {
		if b, err := os.ReadFile(p); err != nil || string(b) != "keep" {
			t.Fatalf("%s changed: %q %v", p, b, err)
		}
	}
}
