package settings

import (
	"slices"
	"testing"
)

// removesKey reports whether the patch deletes the stored OPENAI_API_KEY (present with a nil value).
func removesKey(patch map[string]any) bool {
	v, ok := patch["OPENAI_API_KEY"]
	return ok && v == nil
}

const keyRemoved = "OPENAI_API_KEY: removed because OPENAI_BASE_URL was refused"

// A refused base URL fails closed: the import deletes the stored key, whatever the file holds for it.
func TestImportPatchRemovesTheKeyWhenTheBaseURLIsRefused(t *testing.T) {
	patch, skipped := importPatch(map[string]any{"OPENAI_API_KEY": "sk-test-SECRET", "OPENAI_BASE_URL": "https://h/v1?key=x"})
	if !removesKey(patch) {
		t.Fatal("a refused base URL must remove the stored key, or it routes to a stale endpoint or api.openai.com")
	}
	if _, ok := patch["OPENAI_BASE_URL"]; ok {
		t.Fatal("a refused base URL keeps its stored value")
	}
	if !slices.Contains(skipped, keyRemoved) {
		t.Fatalf("the removed key is reported: %v", skipped)
	}

	// an invalid key in the file is removed too, never kept at its stored value
	if patch, skipped := importPatch(map[string]any{"OPENAI_API_KEY": float64(1), "OPENAI_BASE_URL": "not a url"}); !removesKey(patch) || !slices.Contains(skipped, keyRemoved) {
		t.Fatalf("an invalid key with a refused base URL must remove the stored key: %v", skipped)
	}

	// a file without the key still clears the stored one
	if patch, _ := importPatch(map[string]any{"OPENAI_BASE_URL": "not a url"}); !removesKey(patch) {
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

// A refused OPENAI_API_KEY fails closed too: the stored key must never reach the file's base URL or api.openai.com.
func TestImportPatchRemovesTheKeyWhenTheKeyIsRefused(t *testing.T) {
	const removed = "OPENAI_API_KEY: removed because its value was refused"
	for _, base := range []any{"https://new.example/v1", nil} { // a valid base URL, and none
		for _, key := range []any{float64(123), map[string]any{}} { // the forms 123 and {} as JSON decodes them
			file := map[string]any{"OPENAI_API_KEY": key}
			if base != nil {
				file["OPENAI_BASE_URL"] = base
			}
			patch, skipped := importPatch(file)
			if !removesKey(patch) || !slices.Contains(skipped, removed) {
				t.Fatalf("base %v, key %#v: a refused key must remove the stored key: %v", base, key, skipped)
			}
			if base != nil && patch["OPENAI_BASE_URL"] != base {
				t.Fatalf("base %v: a valid base URL still imports, got %#v", base, patch["OPENAI_BASE_URL"])
			}
		}
		// the accepted form sk-new imports with the same base URL
		file := map[string]any{"OPENAI_API_KEY": "sk-new"}
		if base != nil {
			file["OPENAI_BASE_URL"] = base
		}
		if patch, skipped := importPatch(file); patch["OPENAI_API_KEY"] != "sk-new" || slices.Contains(skipped, removed) {
			t.Fatalf("base %v: the key sk-new must be imported: %v", base, skipped)
		}
	}
}

// The import trims OPENAI_BASE_URL like the resolution rule; any present value it still refuses removes the key.
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
			if !removesKey(patch) || !slices.Contains(skipped, keyRemoved) {
				t.Fatalf("base %#v: a refused base URL removes the key: %v", c.base, skipped)
			}
			continue
		}
		if got != c.wantBase || patch["OPENAI_API_KEY"] != "sk-test-SECRET" {
			t.Fatalf("base %#v: want base %#v and the key imported, got %#v / %v", c.base, c.wantBase, got, skipped)
		}
	}
}
