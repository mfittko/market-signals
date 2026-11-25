package main

import (
	"bytes"
	"io"
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
		if err := run(spec, out, report, io.Discard); err == nil || !strings.Contains(err.Error(), "is the input") {
			t.Errorf("--artifact %s: want a refusal, got %v", out, err)
		}
		if err := run(spec, report, out, io.Discard); err == nil || !strings.Contains(err.Error(), "is the input") {
			t.Errorf("--report %s: want a refusal, got %v", out, err)
		}
	}
	if err := run(spec, report, report, io.Discard); err == nil || !strings.Contains(err.Error(), "same path") {
		t.Errorf("same --artifact and --report: want a refusal, got %v", err)
	}
	if after, _ := os.ReadFile(e0); string(after) != string(before) {
		t.Fatal("the E0 spec changed")
	}
}

func TestRunRefusesTwoSpellingsOrTwoLinksOfOneOutput(t *testing.T) {
	_, spec := layout(t, true)
	dir := t.TempDir()
	sep := string(filepath.Separator)
	// a file that does not exist yet, named twice
	if err := run(spec, dir+sep+"a.json", dir+sep+"."+sep+"a.json", io.Discard); err == nil || !strings.Contains(err.Error(), "same path") {
		t.Errorf("two spellings of one path: want a refusal, got %v", err)
	}
	// a file that does not exist yet, named through a directory and a symlink to it
	link := filepath.Join(t.TempDir(), "d2")
	if err := os.Symlink(dir, link); err != nil {
		t.Fatal(err)
	}
	if err := run(spec, filepath.Join(dir, "c.json"), filepath.Join(link, "c.json"), io.Discard); err == nil || !strings.Contains(err.Error(), "same path") {
		t.Errorf("one path through a directory symlink: want a refusal, got %v", err)
	}
	// an existing file and a hard link to it
	a, b := filepath.Join(dir, "b.json"), filepath.Join(dir, "b-link.md")
	if err := os.WriteFile(a, []byte("keep\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Link(a, b); err != nil {
		t.Fatal(err)
	}
	if err := run(spec, a, b, io.Discard); err == nil || !strings.Contains(err.Error(), "same file") {
		t.Errorf("two links of one file: want a refusal, got %v", err)
	}
	if got, _ := os.ReadFile(a); string(got) != "keep\n" {
		t.Fatal("a refused run changed the output file")
	}
}

func TestRunRefusesCaseVariantOutputsOnACaseInsensitiveFilesystem(t *testing.T) {
	_, spec := layout(t, true)
	dir := t.TempDir()
	probe := filepath.Join(dir, "probe")
	if err := os.WriteFile(probe, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, "PROBE")); err != nil {
		t.Skip("the temporary directory is case-sensitive")
	}
	artifact := filepath.Join(dir, "a.json")
	if err := run(spec, artifact, filepath.Join(dir, "A.json"), io.Discard); err == nil || !strings.Contains(err.Error(), "same file") {
		t.Fatalf("case-variant outputs: want a refusal, got %v", err)
	}
	if b, err := os.ReadFile(artifact); err != nil || !strings.HasPrefix(string(b), "{") {
		t.Fatalf("the artifact on disk is not the artifact JSON: %q, %v", b, err)
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
		if err := run(spec, filepath.Join(dir, "a.json"), filepath.Join(dir, "r.md"), io.Discard); err == nil || !strings.Contains(err.Error(), field) {
			t.Errorf("%s: want a refusal naming the field, got %v", field, err)
		}
	}
}

func TestRunReportsEveryInstrumentWithoutAnExportAsNotRun(t *testing.T) {
	root, spec := layout(t, true)
	dir := t.TempDir()
	report := filepath.Join(dir, "report.md")
	var stderr bytes.Buffer
	if err := run(spec, filepath.Join(dir, "artifact.json"), report, &stderr); err != nil {
		t.Fatal(err)
	}
	// only WTICO/USD pins a dataset sha256, so only its missing export warns, by absolute path
	resolved, err := filepath.EvalSymlinks(root)
	if err != nil {
		t.Fatal(err)
	}
	wti := filepath.Join(resolved, "tmp/research-export/wtico-usd-m1-ba-2023-2026q3.csv")
	if got := stderr.String(); strings.Count(got, "warning:") != 1 || !strings.Contains(got, "WTICO/USD pins dataset sha256 ") || !strings.Contains(got, wti+" does not exist") {
		t.Errorf("stderr %q, want one warning naming WTICO/USD and %s", got, wti)
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
	if err := run(spec, filepath.Join(dir, "a.json"), filepath.Join(dir, "r.md"), io.Discard); err == nil || !strings.Contains(err.Error(), "platform/go.mod") {
		t.Fatalf("want a repository-root refusal, got %v", err)
	}
}
