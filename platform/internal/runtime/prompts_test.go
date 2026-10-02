package runtime

import (
	"strings"
	"testing"

	"github.com/mfittko/market-signals/platform/internal/domain"
)

func TestWakePromptIsNarrowAndEntryPromptAsksForAPlan(t *testing.T) {
	for _, must := range []string{"hold, close the position, tighten the stop toward price", "cannot open a trade", "adverse_atr"} {
		if !strings.Contains(wakeSystem, must) {
			t.Errorf("wake prompt lacks %q", must)
		}
	}
	for _, must := range []string{`"plan":`, "tripwires", "deterministic monitor"} {
		if !strings.Contains(systemPrompt, must) {
			t.Errorf("entry prompt lacks %q", must)
		}
	}
	d, err := domain.ParseDecision(`ok {"action":"open","side":"long","notional":500,"stop":98,"plan":{"maxBars":60,"trail":{"kind":"atr","mult":2},"tripwires":[{"kind":"adverse_atr","atr":1.5},{"kind":"no_progress","bars":30}]},"reasoning":"x"}`)
	if err != nil || d.Plan == nil || len(d.Plan.Tripwires) != 2 || d.Plan.MaxBars != 60 {
		t.Fatalf("%+v %v", d, err)
	}
	if _, err := domain.ParseDecision(`{"action":"open","side":"long","notional":500,"stop":98,"plan":{"tripwires":[{"kind":"made_up"}]}}`); err == nil {
		t.Fatal("an unknown tripwire must fail the shape check")
	}
}
