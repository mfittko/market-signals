// Package testutil gives tests a clean, migrated Postgres database.
// Every package truncates the same database, so run `go test -p 1 ./...`.
package testutil

import (
	"context"
	"errors"
	"os"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/mfittko/market-signals/platform/internal/db"
	"github.com/mfittko/market-signals/platform/migrations"
)

var (
	once sync.Once
	pool *pgxpool.Pool
	perr error
)

// Required reports whether a missing Postgres must fail the run. CI and
// MS_REQUIRE_DB=1 set it, so a broken service container cannot pass as a skip.
func Required() bool {
	return os.Getenv("CI") != "" || os.Getenv("MS_REQUIRE_DB") == "1"
}

// DatabaseURL returns MS_TEST_DATABASE_URL. No credential is committed: scripts/dev.sh
// writes the URL to platform/.dev/env, and CI sets it for its service container.
func DatabaseURL() (string, error) {
	if u := os.Getenv("MS_TEST_DATABASE_URL"); u != "" {
		return u, nil
	}
	return "", errors.New("MS_TEST_DATABASE_URL is not set (scripts/dev.sh up writes it to platform/.dev/env)")
}

// Pool returns a truncated database. When Postgres is down it skips the test,
// or fails it when Required reports true.
func Pool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	once.Do(func() {
		var url string
		if url, perr = DatabaseURL(); perr != nil {
			return
		}
		ctx := context.Background()
		if pool, perr = db.Connect(ctx, url); perr == nil {
			perr = db.Migrate(ctx, pool, migrations.FS)
		}
	})
	if perr != nil && Required() {
		t.Fatal("postgres unavailable and required (CI or MS_REQUIRE_DB=1):", perr)
	}
	if perr != nil {
		t.Skip("postgres unavailable (start it with scripts/dev.sh up, see platform/README.md):", perr)
	}
	ctx := context.Background()
	for _, q := range []string{
		`TRUNCATE run_events, attempts, runs, sessions, agents, workers RESTART IDENTITY CASCADE`,
		`ALTER TABLE snapshots DISABLE TRIGGER snapshots_no_update; TRUNCATE snapshots RESTART IDENTITY CASCADE; ALTER TABLE snapshots ENABLE TRIGGER snapshots_no_update`,
	} {
		if _, err := pool.Exec(ctx, q); err != nil {
			t.Fatal(err)
		}
	}
	return pool
}
