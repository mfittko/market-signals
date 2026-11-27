package monitor

import (
	"context"
	"io"
	"log/slog"
	"testing"
	"time"

	"github.com/mfittko/market-signals/platform/internal/queue"
	"github.com/mfittko/market-signals/platform/internal/testutil"
)

func TestLastPassAgeTracksAMissedPass(t *testing.T) {
	var l LastPass
	if l.AgeSeconds(time.Now()) != nil {
		t.Fatal("before the first pass the age must be nil")
	}
	t0 := time.Date(2026, 1, 1, 10, 0, 0, 0, time.UTC)
	l.Mark(t0)
	if age := l.AgeSeconds(t0.Add(10 * time.Second)); age == nil || *age > Interval.Seconds() {
		t.Fatalf("a running monitor stays within one interval: %v", age)
	}
	if age := l.AgeSeconds(t0.Add(Interval + 16*time.Second)); age == nil || *age <= Interval.Seconds() {
		t.Fatalf("after a missed pass the age must exceed the interval: %v", age)
	}
}

func TestRunMarksOnlyACleanPass(t *testing.T) {
	st := queue.New(testutil.Pool(t))
	fake := time.Date(2026, 1, 1, 10, 0, 0, 0, time.UTC)
	svc := &Service{Store: st, Feed: &fakeFeed{}, Log: slog.New(slog.NewTextHandler(io.Discard, nil)), Now: func() time.Time { return fake }, LastPass: &LastPass{}}

	// a cancelled context fails the tick, so nothing is marked
	done, cancel := context.WithCancel(context.Background())
	cancel()
	svc.Run(done, time.Hour)
	if svc.LastPass.AgeSeconds(fake) != nil {
		t.Fatal("a failed tick must not mark a pass")
	}

	ctx, stop := context.WithCancel(context.Background())
	go func() {
		deadline := time.Now().Add(5 * time.Second)
		for svc.LastPass.AgeSeconds(fake) == nil && time.Now().Before(deadline) {
			time.Sleep(time.Millisecond)
		}
		stop()
	}()
	svc.Run(ctx, time.Hour)
	if age := svc.LastPass.AgeSeconds(fake.Add(3 * time.Second)); age == nil || *age != 3 {
		t.Fatalf("the clean pass must be marked at the monitor clock: %v", age)
	}
}
