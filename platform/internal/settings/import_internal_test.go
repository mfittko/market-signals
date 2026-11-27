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
