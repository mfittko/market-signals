package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// layout copies the frozen BB and E0 specs into a temporary root, with the
// platform/go.mod repository marker when inRepo is set.
func layout(t *testing.T, inRepo bool) (root, spec string) {
	t.Helper()
	root = t.TempDir()
	for _, rel := range []string{"docs/research/experiments/bb/spec.json", "docs/research/experiments/e0/spec.json"} {
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
	if inRepo {
		if err := os.MkdirAll(filepath.Join(root, "platform"), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(root, "platform", "go.mod"), []byte("module x\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return root, filepath.Join(root, "docs/research/experiments/bb/spec.json")
}

func TestRunRefusesAnOutputThatIsAnInputOrTheOtherOutput(t *testing.T) {
	root, spec := layout(t, true)
	e0 := filepath.Join(root, "docs/research/experiments/e0/spec.json")
	before, _ := os.ReadFile(e0)
	report := filepath.Join(t.TempDir(), "report.md")
	for _, out := range []string{spec, e0} {
		if err := run(spec, out, report); err == nil || !strings.Contains(err.Error(), "is the input") {
			t.Errorf("--artifact %s: want a refusal, got %v", out, err)
		}
		if err := run(spec, report, out); err == nil || !strings.Contains(err.Error(), "is the input") {
			t.Errorf("--report %s: want a refusal, got %v", out, err)
		}
	}
	if err := run(spec, report, report); err == nil || !strings.Contains(err.Error(), "same path") {
		t.Errorf("same --artifact and --report: want a refusal, got %v", err)
	}
	if after, _ := os.ReadFile(e0); string(after) != string(before) {
		t.Fatal("the E0 spec changed")
	}
}

func TestRunRefusesAnInputPathThatLeavesTheRepository(t *testing.T) {
	_, spec := layout(t, true)
	good, err := os.ReadFile(spec)
	if err != nil {
		t.Fatal(err)
	}
	for field, from := range map[string]string{
		"e0Spec.path":            `"docs/research/experiments/e0/spec.json"`,
		"WTICO/USD dataset.path": `"tmp/research-export/wtico-usd-m1-ba-2023-2026q3.csv"`,
	} {
		bad := strings.Replace(string(good), from, `"../outside.csv"`, 1)
		if bad == string(good) {
			t.Fatalf("edit %s did not change the spec", from)
		}
		if err := os.WriteFile(spec, []byte(bad), 0o644); err != nil {
			t.Fatal(err)
		}
		dir := t.TempDir()
		if err := run(spec, filepath.Join(dir, "a.json"), filepath.Join(dir, "r.md")); err == nil || !strings.Contains(err.Error(), field) {
			t.Errorf("%s: want a refusal naming the field, got %v", field, err)
		}
	}
}

func TestRunReportsEveryInstrumentWithoutAnExportAsNotRun(t *testing.T) {
	_, spec := layout(t, true)
	dir := t.TempDir()
	report := filepath.Join(dir, "report.md")
	if err := run(spec, filepath.Join(dir, "artifact.json"), report); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(report)
	if err != nil {
		t.Fatal(err)
	}
	for _, inst := range []string{"NAS100/USD", "SPX500/USD", "US30/USD", "DE30/EUR", "WTICO/USD"} {
		if !strings.Contains(string(b), "- "+inst+": no export.") {
			t.Errorf("report does not list %s as not run", inst)
		}
	}
}

func TestRunRefusesASpecOutsideTheRepository(t *testing.T) {
	_, spec := layout(t, false)
	dir := t.TempDir()
	if err := run(spec, filepath.Join(dir, "a.json"), filepath.Join(dir, "r.md")); err == nil || !strings.Contains(err.Error(), "platform/go.mod") {
		t.Fatalf("want a repository-root refusal, got %v", err)
	}
}
