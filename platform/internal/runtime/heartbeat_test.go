package runtime

import (
	"testing"
	"time"

	"github.com/mfittko/market-signals/platform/internal/queue"
)

func TestHeartbeatIsAQuarterOfTheClaimedLease(t *testing.T) {
	for _, c := range []struct {
		w    Worker
		b    queue.Budgets
		want time.Duration
	}{
		{Worker{}, queue.Budgets{LeaseSeconds: 5}, 1250 * time.Millisecond},
		{Worker{}, queue.Budgets{}, 7500 * time.Millisecond},
		{Worker{Heartbeat: 100 * time.Millisecond}, queue.Budgets{LeaseSeconds: 5}, 100 * time.Millisecond},
	} {
		if got := c.w.heartbeat(c.b); got != c.want {
			t.Fatalf("heartbeat(%+v, override %v) = %v, want %v", c.b, c.w.Heartbeat, got, c.want)
		}
	}
}
