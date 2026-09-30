package domain

import (
	"encoding/json"
	"errors"
	"strings"
)

// ParseDecision returns the LAST decision-shaped JSON object in model text. The prompt ends the reply
// with the decision, so an earlier object is a considered-and-rejected alternative or a quoted example
// and must never become the proposal. If the last object fails the shape rules or carries a field of
// the wrong type, the result is that error and never an earlier valid object; callers turn an error
// into a fail-safe hold. Surrounding prose and code fences are tolerated.
func ParseDecision(text string) (*Decision, error) {
	var last *Decision
	var lastErr error
	found := false
	for i := 0; i < len(text); i++ {
		if text[i] != '{' {
			continue
		}
		dec := json.NewDecoder(strings.NewReader(text[i:]))
		var obj json.RawMessage
		if err := dec.Decode(&obj); err != nil {
			continue
		}
		// An object is decision-shaped when it names a non-empty action. Outer wrappers without one
		// are skipped, so a nested decision is still found.
		var probe map[string]any
		if err := json.Unmarshal(obj, &probe); err != nil {
			continue
		}
		if a, ok := probe["action"]; !ok || a == "" {
			continue
		}
		found = true
		var d Decision
		if err := json.Unmarshal(obj, &d); err != nil {
			last, lastErr = nil, err
		} else {
			last, lastErr = &d, d.CheckShape()
		}
		i += int(dec.InputOffset()) - 1 // skip this object's inner braces
	}
	if !found {
		return nil, errors.New("no decision object in reply")
	}
	if lastErr != nil {
		return nil, lastErr
	}
	return last, nil
}
