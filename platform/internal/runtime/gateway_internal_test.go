package runtime

import (
	"strings"
	"testing"
)

// A key that prefixes a query value, and a query value the provider echoes URL-encoded, leave no remainder.
func TestRedactRemovesNestedAndEncodedSecrets(t *testing.T) {
	for _, c := range []struct{ body, full, apiKey string }{
		{"echo sk-abc-extra and sk-abc", "https://h/v1/chat/completions?key=sk-abc-extra", "sk-abc"},
		{"echo a%2Fb%3DSECRET", "https://h/v1/chat/completions?key=a%2Fb%3DSECRET", "sk-test"},
	} {
		if got := redact(c.body, c.full, c.apiKey); strings.Contains(got, "extra") || strings.Contains(got, "SECRET") || strings.Contains(got, "sk-abc") {
			t.Fatalf("redact leaks a secret remainder: %q", got)
		}
	}
}

func TestRedactRemovesTheURLUsernameAndPassword(t *testing.T) {
	got := redact("user userSECRET pass passSECRET q qSECRET key sk-test-SECRET", "http://userSECRET:passSECRET@h/v1/chat/completions?k=qSECRET", "sk-test-SECRET")
	if strings.Contains(got, "SECRET") {
		t.Fatalf("redact leaks a secret: %q", got)
	}
}
