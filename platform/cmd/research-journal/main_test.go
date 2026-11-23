package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

const (
	spec = "../../internal/research/testdata/spec.json"
	data = "../../internal/research/testdata/fixture.csv"
)

func TestReportOnTheFixtureJournal(t *testing.T) {
	dir := t.TempDir()
	journal, report := filepath.Join(dir, "journal.jsonl"), filepath.Join(dir, "report.md")
	if err := run(spec, data, journal, report); err != nil {
		t.Fatal(err)
	}
	j, _ := os.ReadFile(journal)
	sum := sha256.Sum256(j)
	b, err := os.ReadFile(report)
	if err != nil {
		t.Fatal(err)
	}
	r := string(b)
	for _, want := range []string{
		"## Operational correctness", "## Calibration and coverage", "## Cost-aware results", "## Insufficient evidence",
		"This report claims no edge and no profitable strategy.",
		"| Mode | retrospective |",
		"| Journal sha256 | `" + hex.EncodeToString(sum[:]) + "` |",
		"| Go version and platform | `" + runtime.Version() + " " + runtime.GOOS + "/" + runtime.GOARCH + "` |",
		"reads the journal file and the frozen spec that the table below pins by sha256.",
		"| Spec sha256 | `", "| Data sha256 | `5a9ec8f0e32166cf58082d20f0cabe49c11f7b80a9a0c7882ff532ee6b1fc383` |",
		"| Financing basis | 4.7% a year | assumed |", "| Decision delay | 2212 ms | measured |",
	} {
		if !strings.Contains(r, want) {
			t.Errorf("report lacks %q:\n%s", want, r)
		}
	}
}

func TestARebuildIntoTheSameJournalIsRefused(t *testing.T) {
	dir := t.TempDir()
	journal, report := filepath.Join(dir, "journal.jsonl"), filepath.Join(dir, "report.md")
	if err := run(spec, data, journal, report); err != nil {
		t.Fatal(err)
	}
	before, _ := os.ReadFile(journal)
	if err := run(spec, data, journal, report); err == nil || !strings.Contains(err.Error(), "already in the journal") {
		t.Fatalf("second run: want a duplicate-id refusal, got %v", err)
	}
	if after, _ := os.ReadFile(journal); !bytes.Equal(before, after) {
		t.Fatal("the refused rebuild changed the journal")
	}
}

func TestARunOfAnotherSpecIntoTheJournalIsRefused(t *testing.T) {
	dir := t.TempDir()
	journal, report := filepath.Join(dir, "journal.jsonl"), filepath.Join(dir, "report.md")
	if err := run(spec, data, journal, report); err != nil {
		t.Fatal(err)
	}
	before, _ := os.ReadFile(journal)
	b, err := os.ReadFile(spec)
	if err != nil {
		t.Fatal(err)
	}
	other := filepath.Join(dir, "spec.json")
	if err := os.WriteFile(other, bytes.Replace(b, []byte(`"E0-fixture"`), []byte(`"E1-fixture"`), 1), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := run(other, data, journal, report); err == nil || !strings.Contains(err.Error(), "holds attempt") || !strings.Contains(err.Error(), "rerun with a new --journal path") {
		t.Fatalf("run of another experiment id: want a mixed-run refusal, got %v", err)
	}
	if after, _ := os.ReadFile(journal); !bytes.Equal(before, after) {
		t.Fatal("the refused run changed the journal")
	}
}

func TestAReportWriteFailureNamesTheRecovery(t *testing.T) {
	dir := t.TempDir()
	journal := filepath.Join(dir, "journal.jsonl")
	err := run(spec, data, journal, filepath.Join(dir, "missing", "report.md"))
	if err == nil || !strings.Contains(err.Error(), "rerun with a new --journal path") {
		t.Fatalf("want the report-write refusal with the recovery, got %v", err)
	}
	if _, err := os.Stat(journal); err != nil {
		t.Fatalf("the journal is not written before the report: %v", err)
	}
}

func TestRunRefusesAReportThatIsAnInput(t *testing.T) {
	dir := t.TempDir()
	// copies, so a guard regression truncates temporary files and never the tracked fixtures
	spec, data := filepath.Join(dir, "spec.json"), filepath.Join(dir, "fixture.csv")
	for dst, src := range map[string]string{spec: "../../internal/research/testdata/spec.json", data: "../../internal/research/testdata/fixture.csv"} {
		b, err := os.ReadFile(src)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(dst, b, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	journal := filepath.Join(dir, "journal.jsonl")
	if err := os.WriteFile(journal, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	for _, report := range []string{spec, data, journal} {
		if err := run(spec, data, journal, report); err == nil || !strings.Contains(err.Error(), "is the input") {
			t.Errorf("--report %s: want a refusal, got %v", report, err)
		}
	}
	fresh := filepath.Join(dir, "new.jsonl")
	if err := run(spec, data, fresh, filepath.Join(dir, ".", "new.jsonl")); err == nil || !strings.Contains(err.Error(), "is the input") {
		t.Errorf("--report equal to a not-yet-existing --journal: want a refusal, got %v", err)
	}
	if _, err := os.Stat(fresh); !os.IsNotExist(err) {
		t.Errorf("the refused run created %s", fresh)
	}
}
