package monitor

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"reflect"
	"testing"

	"github.com/mfittko/market-signals/platform/internal/domain"
	"github.com/mfittko/market-signals/platform/internal/golden"
)

var update = flag.Bool("update", false, "re-record the expected values of test/golden/monitor.json from Step")

const goldenFile = "../../../test/golden/monitor.json"

// A monitor case is one position and its ordered bars. Expected holds one Result per bar.
type goldenInput struct {
	Kind     string   `json:"kind"` // step
	Position Position `json:"position"`
	Bars     []struct {
		Bar Bar `json:"bar"`
		Env Env `json:"env"`
	} `json:"bars"`
}

type goldenExpected struct {
	Steps []json.RawMessage `json:"steps"`
}

// replay feeds the bars through Step, carrying the position from one bar to the next.
func replay(raw json.RawMessage) ([]Result, error) {
	var in goldenInput
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&in); err != nil {
		return nil, err
	}
	if in.Kind != "step" || len(in.Bars) == 0 {
		return nil, fmt.Errorf("input kind %q with %d bars, want step with bars", in.Kind, len(in.Bars))
	}
	// Replay only positions the monitor can receive, so a typo cannot pin the wrong branch.
	if err := in.Position.Plan.Check(in.Position.Side); err != nil {
		return nil, fmt.Errorf("position: %w", err)
	}
	p, out := in.Position, []Result{}
	for i, b := range in.Bars {
		if i > 0 && out[i-1].Exit != nil {
			return nil, fmt.Errorf("bar %d follows the exit", i+1)
		}
		r := Step(p, b.Bar, b.Env)
		p = r.Pos
		// Step never edits the plan; checking that here keeps it out of every recorded step.
		if !reflect.DeepEqual(r.Pos.Plan, in.Position.Plan) {
			return nil, fmt.Errorf("bar %d changed the plan to %+v", i+1, r.Pos.Plan)
		}
		r.Pos.Plan = domain.Plan{}
		out = append(out, r)
	}
	return out, nil
}

func TestReplayChecksPositionSide(t *testing.T) {
	for side, ok := range map[string]bool{"long": true, "short": true, "Short": false, "": false, "buy": false} {
		input := fmt.Sprintf(`{"kind":"step","position":{"side":%q,"entry":100,"stop":95},"bars":[{"bar":{},"env":{}}]}`, side)
		if _, err := replay(json.RawMessage(input)); (err == nil) != ok {
			t.Errorf("side %q: replay error %v, want accepted=%v", side, err, ok)
		}
	}
}

func loadGolden(t *testing.T) golden.File {
	t.Helper()
	data, err := os.ReadFile(goldenFile)
	if err != nil {
		t.Fatal(err)
	}
	f, err := golden.Decode(data, "monitor")
	if err != nil {
		t.Fatal(err)
	}
	return f
}

func TestGoldenReplay(t *testing.T) {
	f := loadGolden(t)
	for i, c := range f.Cases {
		got, err := replay(c.Input)
		if err != nil {
			t.Fatalf("%s: %v", c.Name, err)
		}
		if *update {
			if f.Cases[i].Expected, err = json.Marshal(map[string]any{"steps": got}); err != nil {
				t.Fatal(err)
			}
			continue
		}
		var want goldenExpected
		if err := json.Unmarshal(c.Expected, &want); err != nil {
			t.Fatalf("%s: %v", c.Name, err)
		}
		if len(want.Steps) != len(got) {
			t.Errorf("%s: %d results, recorded %d", c.Name, len(got), len(want.Steps))
			continue
		}
		for j := range got {
			if err := golden.Match(got[j], want.Steps[j]); err != nil {
				t.Errorf("%s bar %d of %d: %v", c.Name, j+1, len(got), err)
			}
		}
	}
	if *update {
		data, err := golden.Encode(f)
		if err == nil {
			err = os.WriteFile(goldenFile, data, 0o644)
		}
		if err != nil {
			t.Fatal(err)
		}
	}
}

// TestGoldenCoversEveryRuleBranch is the drift guard: every exit reason and every
// tripwire kind must appear in a recorded outcome, so a new branch in Step needs a case.
func TestGoldenCoversEveryRuleBranch(t *testing.T) {
	seen := map[string]bool{}
	for _, c := range loadGolden(t).Cases {
		got, err := replay(c.Input)
		if err != nil {
			t.Fatalf("%s: %v", c.Name, err)
		}
		var in goldenInput
		if err := json.Unmarshal(c.Input, &in); err != nil {
			t.Fatalf("%s: %v", c.Name, err)
		}
		for _, r := range got {
			if r.Exit != nil {
				seen["exit:"+r.Exit.Reason] = true
			}
			if r.Trailed {
				seen["trail:"+in.Position.Plan.Trail.Kind] = true
			}
			for _, tw := range r.Fired {
				seen["tripwire:"+tw.Kind] = true
			}
		}
	}
	for _, want := range []string{
		"exit:stop", "exit:target", "exit:invalidated", "exit:time_stop", "exit:kill_switch",
		"trail:atr", "trail:supertrend",
		"tripwire:close_beyond", "tripwire:price_cross", "tripwire:adverse_pct", "tripwire:adverse_atr",
		"tripwire:no_progress", "tripwire:opposite_flip", "tripwire:impulse", "tripwire:news_escalation",
		"tripwire:feed_stale",
	} {
		if !seen[want] {
			t.Errorf("no golden case records %s", want)
		}
	}
}
