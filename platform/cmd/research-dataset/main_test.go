package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// repo builds a temporary repository with the research fixture export at tmp/export.csv.
func repo(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	csv, err := os.ReadFile("../../internal/research/testdata/dataset.csv")
	if err != nil {
		t.Fatal(err)
	}
	for p, b := range map[string][]byte{"platform/go.mod": []byte("module x\n"), "tmp/export.csv": csv} {
		full := filepath.Join(root, p)
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, b, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return root
}

func writeManifest(t *testing.T, root string, edit func(map[string]any)) string {
	t.Helper()
	m, err := describe(filepath.Join(root, "tmp/export.csv"), "WTICO/USD", "M1")
	if err != nil {
		t.Fatal(err)
	}
	m.Path = "tmp/export.csv"
	b, _ := json.Marshal(m)
	var v map[string]any
	if err := json.Unmarshal(b, &v); err != nil {
		t.Fatal(err)
	}
	edit(v)
	b, _ = json.Marshal(v)
	p := filepath.Join(root, "docs/research/datasets/export.json")
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, b, 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestVerifyResolvesThePathFromTheManifestsRepository(t *testing.T) {
	root := repo(t)
	ok, err := run([]string{"verify", writeManifest(t, root, func(map[string]any) {})})
	if !ok || err != nil {
		t.Fatalf("ok %v, err %v", ok, err)
	}
}

func TestVerifyFailsOnAMismatch(t *testing.T) {
	root := repo(t)
	ok, err := run([]string{"verify", writeManifest(t, root, func(v map[string]any) { v["rows"] = 9 })})
	if ok || err != nil {
		t.Fatalf("ok %v, err %v; want a mismatch", ok, err)
	}
}

func TestVerifyRefusesAPathOutsideTheRepository(t *testing.T) {
	root := repo(t)
	_, err := run([]string{"verify", writeManifest(t, root, func(v map[string]any) { v["path"] = "../x.csv" })})
	if err == nil || !strings.Contains(err.Error(), "not relative") {
		t.Fatalf("err %v", err)
	}
}

func TestRunRefusesBadUsage(t *testing.T) {
	for _, args := range [][]string{nil, {"verify"}, {"verify", "a", "b"}, {"other", "x"}, {"describe", "x.csv"}} {
		if _, err := run(args); err == nil {
			t.Errorf("%v: no error", args)
		}
	}
}
