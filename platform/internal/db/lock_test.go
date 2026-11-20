package db_test

import (
	"context"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/mfittko/market-signals/platform/internal/db"
	"github.com/mfittko/market-signals/platform/internal/testutil"
)

func TestStackLockRefusesASecondHolderAndReleasesWithTheSession(t *testing.T) {
	url, err := testutil.DatabaseURL()
	if err != nil {
		if testutil.Required() {
			t.Fatal(err)
		}
		t.Skip(err)
	}
	ctx := context.Background()
	first, err := db.HoldStackLock(ctx, url, "ms-api first")
	if err != nil {
		if testutil.Required() {
			t.Fatal(err)
		}
		t.Skip("postgres unavailable:", err)
	}
	defer first.Close(ctx)

	second, err := db.HoldStackLock(ctx, url, "ms-api second")
	if err == nil {
		second.Close(ctx)
		t.Fatal("a second holder took the lock")
	}
	var name string
	if err := first.QueryRow(ctx, `SELECT current_database()`).Scan(&name); err != nil {
		t.Fatal(err)
	}
	want := `^database ` + regexp.QuoteMeta(name) + ` is held by another control plane: backend pid \d+, application_name "ms-api first", started \d{4}-`
	if !regexp.MustCompile(want).MatchString(err.Error()) {
		t.Fatalf("refusal %q does not match %s", err, want)
	}

	// closing the holder's session releases the lock, as a killed process does
	if err := first.Close(ctx); err != nil {
		t.Fatal(err)
	}
	third, err := db.HoldStackLock(ctx, url, "ms-api third")
	if err != nil {
		t.Fatal("lock not released after the holder closed:", err)
	}
	third.Close(ctx)
}

func TestWatchStackLockReportsALostSession(t *testing.T) {
	url, err := testutil.DatabaseURL()
	if err != nil {
		if testutil.Required() {
			t.Fatal(err)
		}
		t.Skip(err)
	}
	ctx := context.Background()
	holder, err := db.HoldStackLock(ctx, url, "ms-api watched")
	if err != nil {
		if testutil.Required() {
			t.Fatal(err)
		}
		t.Skip("postgres unavailable:", err)
	}
	lost := make(chan error, 1)
	go func() { lost <- db.WatchStackLock(ctx, holder, 50*time.Millisecond) }()

	// ending the holder's backend is what a Postgres restart does to the lock session
	killer, err := pgx.Connect(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer killer.Close(ctx)
	if _, err := killer.Exec(ctx, `SELECT pg_terminate_backend($1)`, int32(holder.PgConn().PID())); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-lost:
		if err == nil || !strings.Contains(err.Error(), "stack lock session lost") {
			t.Fatalf("watcher returned %v, want a lost-session error", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("watcher did not report the lost session")
	}
}
