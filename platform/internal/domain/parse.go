package domain

import (
	"encoding/json"
	"errors"
	"strings"
)

// ParseDecision returns the LAST decision-shaped JSON object in model text. The prompt ends the reply
// with the decision, so an earlier object is a considered-and-rejected alternative or a quoted example
// and must never become the proposal. If the last object fails the shape rules the result is that
// error, not an earlier valid object; callers turn an error into a fail-safe hold. Surrounding prose
// and code fences are tolerated.
func ParseDecision(text string) (*Decision, error) {
	var last *Decision
	var lastErr error
	for i := 0; i < len(text); i++ {
		if text[i] != '{' {
			continue
		}
		dec := json.NewDecoder(strings.NewReader(text[i:]))
		var d Decision
		if err := dec.Decode(&d); err != nil || d.Action == "" {
			continue
		}
		last, lastErr = &d, d.CheckShape()
		i += int(dec.InputOffset()) - 1 // skip this object's inner braces
	}
	if last == nil {
		return nil, errors.New("no decision object in reply")
	}
	if lastErr != nil {
		return nil, lastErr
	}
	return last, nil
}
