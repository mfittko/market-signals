package domain

import (
	"encoding/json"
	"errors"
	"strings"
)

// ParseDecision finds the first JSON object in model text that decodes as a
// decision and passes the shape rules. Surrounding prose, code fences and
// earlier brace pairs are tolerated; anything else is an error, which callers
// turn into a fail-safe hold.
func ParseDecision(text string) (*Decision, error) {
	var lastErr error = errors.New("no decision object in reply")
	for i := 0; i < len(text); i++ {
		if text[i] != '{' {
			continue
		}
		var d Decision
		if err := json.NewDecoder(strings.NewReader(text[i:])).Decode(&d); err != nil || d.Action == "" {
			continue
		}
		if err := d.CheckShape(); err != nil {
			lastErr = err
			continue
		}
		return &d, nil
	}
	return nil, lastErr
}
