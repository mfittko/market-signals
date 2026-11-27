package api

import (
	"reflect"
	"testing"

	"github.com/mfittko/market-signals/platform/internal/queue"
)

func TestDegradedConditions(t *testing.T) {
	online := func(rts ...string) queue.WorkerInfo { return queue.WorkerInfo{Runtimes: rts, Online: true} }
	agent := func(rt string, enabled bool) queue.Agent { return queue.Agent{Runtime: rt, Enabled: enabled} }
	missing := func(d string) []degradedCondition { return []degradedCondition{{"worker_missing", d}} }
	cases := []struct {
		name                  string
		configured, reachable bool
		workers               []queue.WorkerInfo
		agents                []queue.Agent
		want                  []degradedCondition
	}{
		{"clear", true, true, []queue.WorkerInfo{online("rules", "llm")}, []queue.Agent{agent("llm", true), agent("rules", true)}, []degradedCondition{}},
		{"engine unreachable", true, false, nil, nil, []degradedCondition{{"engine_unreachable", "the control plane cannot reach the engine"}}},
		{"engine not configured", false, false, nil, nil, []degradedCondition{}},
		{"disabled agent", true, true, nil, []queue.Agent{agent("llm", false)}, []degradedCondition{}},
		{"offline worker", true, true, []queue.WorkerInfo{{Runtimes: []string{"llm"}}}, []queue.Agent{agent("llm", true)}, missing("no online worker offers runtime llm")},
		{"sorted deduplicated runtimes", true, true, []queue.WorkerInfo{online("rules")},
			[]queue.Agent{agent("zeta", true), agent("llm", true), agent("zeta", true), agent("rules", true)}, missing("no online worker offers runtime llm, zeta")},
	}
	for _, c := range cases {
		if got := degradedConditions(c.configured, c.reachable, c.workers, c.agents, 0, 5); !reflect.DeepEqual(got, c.want) {
			t.Errorf("%s: got %v, want %v", c.name, got, c.want)
		}
	}
}

func TestDegradedModelCapReached(t *testing.T) {
	for _, c := range []struct {
		spent, capUSD float64
		want          []degradedCondition
	}{
		{4.999, 5, []degradedCondition{}},
		{5, 5, []degradedCondition{{"model_cap_reached", "model spend $5.00 of the $5.00 daily cap; model calls are refused until 00:00 UTC"}}},
		{7.5, 5, []degradedCondition{{"model_cap_reached", "model spend $7.50 of the $5.00 daily cap; model calls are refused until 00:00 UTC"}}},
	} {
		if got := degradedConditions(false, false, nil, nil, c.spent, c.capUSD); !reflect.DeepEqual(got, c.want) {
			t.Errorf("spent %v of %v: got %v, want %v", c.spent, c.capUSD, got, c.want)
		}
	}
}
