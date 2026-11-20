package db_test

import (
	"context"
	"regexp"
	"testing"

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
