package runtime

import (
	"strings"
	"testing"
)

func TestRedactRemovesTheURLUsernameAndPassword(t *testing.T) {
	got := redact("user userSECRET pass passSECRET q qSECRET key sk-test-SECRET", "http://userSECRET:passSECRET@h/v1/chat/completions?k=qSECRET", "sk-test-SECRET")
	if strings.Contains(got, "SECRET") {
		t.Fatalf("redact leaks a secret: %q", got)
	}
}
