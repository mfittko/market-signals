package settings

import (
	"slices"
	"testing"
)

func TestImportPatchSkipsTheKeyWhenTheBaseURLIsRefused(t *testing.T) {
	patch, skipped := importPatch(map[string]any{"OPENAI_API_KEY": "sk-test-SECRET", "OPENAI_BASE_URL": "https://h/v1?key=x"})
	if _, ok := patch["OPENAI_API_KEY"]; ok {
		t.Fatal("a refused base URL must keep the key out of the import, or it routes to api.openai.com")
	}
	if !slices.Contains(skipped, "OPENAI_API_KEY: skipped because OPENAI_BASE_URL was refused") {
		t.Fatalf("the skipped key is reported: %v", skipped)
	}

	// a file without the key still clears the stored one
	if patch, _ := importPatch(map[string]any{"OPENAI_BASE_URL": "not a url"}); patch["OPENAI_API_KEY"] != nil {
		t.Fatal("a missing key must still delete the stored key")
	} else if _, ok := patch["OPENAI_API_KEY"]; !ok {
		t.Fatal("a missing key must still delete the stored key")
	}

	for _, base := range []any{"https://h/v1", "", nil} {
		file := map[string]any{"OPENAI_API_KEY": "sk-test-SECRET"}
		if base != nil {
			file["OPENAI_BASE_URL"] = base
		}
		if patch, _ := importPatch(file); patch["OPENAI_API_KEY"] != "sk-test-SECRET" {
			t.Fatalf("base %v: the key must be imported", base)
		}
	}
}

// The import trims OPENAI_BASE_URL like the resolution rule; any present value it still refuses keeps the key out.
func TestImportPatchTrimsTheBaseURLAndGuardsTheKeyForEveryRefusedForm(t *testing.T) {
	for _, c := range []struct {
		base     any
		wantBase any // nil: refused, so absent from the patch
	}{
		{"https://llm.example/v1", "https://llm.example/v1"},
		{" https://llm.example/v1 ", "https://llm.example/v1"},
		{"  ", ""},
		{"", ""},
		{"://bad", nil},
		{"42", nil},
		{float64(42), nil},
	} {
		patch, skipped := importPatch(map[string]any{"OPENAI_API_KEY": "sk-test-SECRET", "OPENAI_BASE_URL": c.base})
		got, present := patch["OPENAI_BASE_URL"]
		if c.wantBase == nil {
			if present {
				t.Fatalf("base %#v must be refused, got %#v", c.base, got)
			}
			if _, ok := patch["OPENAI_API_KEY"]; ok || !slices.Contains(skipped, "OPENAI_API_KEY: skipped because OPENAI_BASE_URL was refused") {
				t.Fatalf("base %#v: a refused base URL keeps the key out: %v", c.base, skipped)
			}
			continue
		}
		if got != c.wantBase || patch["OPENAI_API_KEY"] != "sk-test-SECRET" {
			t.Fatalf("base %#v: want base %#v and the key imported, got %#v / %v", c.base, c.wantBase, got, skipped)
		}
	}
}
