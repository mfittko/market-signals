// Package testutil gives tests a clean, migrated Postgres database.
package testutil

import (
	"context"
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

// Pool returns a truncated database, or skips the test when Postgres is down.
func Pool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	once.Do(func() {
		url := os.Getenv("MS_TEST_DATABASE_URL")
		if url == "" {
			url = "postgres://ms:ms@127.0.0.1:5544/ms_test"
		}
		ctx := context.Background()
		if pool, perr = db.Connect(ctx, url); perr == nil {
			perr = db.Migrate(ctx, pool, migrations.FS)
		}
	})
	if perr != nil {
		t.Skip("postgres unavailable (docker compose up -d postgres in platform/):", perr)
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
