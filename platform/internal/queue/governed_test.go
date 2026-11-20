package queue

import "testing"

func TestGovernedPicksTheFrozenStrategyThenTheEngines(t *testing.T) {
	cases := []struct{ name, payload, frozen, want string }{
		{"frozen wins, engine kept without prompt",
			`{"engineStrategy":{"name":"e","prompt":"p"}}`, `{"name":"c","version":1,"prompt":"q"}`,
			`{"engineStrategy":{"name":"e"},"strategy":{"name":"c","prompt":"q","version":1}}`},
		{"engine governs without a frozen strategy",
			`{"engineStrategy":{"name":"e","prompt":"p"}}`, ``,
			`{"engineStrategy":{"name":"e"},"strategy":{"name":"e","prompt":"p"}}`},
		{"old snapshot is returned as stored", `{"strategy": {"name":"old"}}`, ``, `{"strategy": {"name":"old"}}`},
		{"frozen JSON null is no strategy", `{"strategy": {"name":"old"}}`, `null`, `{"strategy": {"name":"old"}}`},
		{"non-object payload passes through", `[1,2]`, `{"name":"c"}`, `[1,2]`},
		{"malformed payload passes through", `{`, `{"name":"c"}`, `{`},
		{"engineStrategy of the wrong type is ignored", `{"engineStrategy":"e"}`, ``, `{"engineStrategy":"e"}`},
	}
	for _, c := range cases {
		var frozen []byte
		if c.frozen != "" {
			frozen = []byte(c.frozen)
		}
		if got := string(governed([]byte(c.payload), frozen)); got != c.want {
			t.Errorf("%s: got %s, want %s", c.name, got, c.want)
		}
	}
}
