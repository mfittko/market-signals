package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
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

func TestRunRefusesAReportThatIsAnInput(t *testing.T) {
	dir := t.TempDir()
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
