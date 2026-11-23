package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// layout copies the frozen F316 and E0 specs into a temporary repository root.
func layout(t *testing.T) (root, spec string) {
	t.Helper()
	root = t.TempDir()
	for _, rel := range []string{"docs/research/experiments/f316/spec.json", "docs/research/experiments/e0/spec.json"} {
		b, err := os.ReadFile(filepath.Join("../../..", rel))
		if err != nil {
			t.Fatal(err)
		}
		p := filepath.Join(root, rel)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, b, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return root, filepath.Join(root, "docs/research/experiments/f316/spec.json")
}

func TestRunRefusesAnOutputThatIsAnInput(t *testing.T) {
	root, spec := layout(t)
	if err := os.MkdirAll(filepath.Join(root, "platform"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "platform", "go.mod"), []byte("module x\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	e0 := filepath.Join(root, "docs/research/experiments/e0/spec.json")
	before, _ := os.ReadFile(e0)
	for _, out := range []string{spec, e0} {
		if err := run(spec, out); err == nil || !strings.Contains(err.Error(), "is the input") {
			t.Errorf("--out %s: want a refusal, got %v", out, err)
		}
	}
	if after, _ := os.ReadFile(e0); string(after) != string(before) {
		t.Fatal("the E0 spec changed")
	}
}

func TestRunRefusesAnInputPathThatLeavesTheRepository(t *testing.T) {
	root, spec := layout(t)
	if err := os.MkdirAll(filepath.Join(root, "platform"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "platform", "go.mod"), []byte("module x\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	good, err := os.ReadFile(spec)
	if err != nil {
		t.Fatal(err)
	}
	for field, from := range map[string]string{
		"e0Spec.path":   `"docs/research/experiments/e0/spec.json"`,
		"verdicts.path": `"tmp/research-export/wtico-usd-filter-verdicts-to-2026-09-30.csv"`,
	} {
		bad := strings.Replace(string(good), from, `"../outside.csv"`, 1)
		if bad == string(good) {
			t.Fatalf("edit %s did not change the spec", from)
		}
		if err := os.WriteFile(spec, []byte(bad), 0o644); err != nil {
			t.Fatal(err)
		}
		if err := run(spec, filepath.Join(t.TempDir(), "report.md")); err == nil || !strings.Contains(err.Error(), field) {
			t.Errorf("%s: want a refusal naming the field, got %v", field, err)
		}
	}
}

func TestRunRefusesASpecOutsideTheRepository(t *testing.T) {
	_, spec := layout(t)
	if err := run(spec, filepath.Join(t.TempDir(), "report.md")); err == nil || !strings.Contains(err.Error(), "platform/go.mod") {
		t.Fatalf("want a repository-root refusal, got %v", err)
	}
}
