// Command strategies-import mirrors the engine's strategy versions into the Go strategy store.
// It is one way and rerunnable: only versions Postgres does not hold are inserted, and the active and archived
// flags of versions taken from the engine follow the engine. The engine stays the writer.
//
//	go run ./cmd/strategies-import --sqlite ../data/candles.db
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"syscall"

	"github.com/mfittko/market-signals/platform/internal/db"
	"github.com/mfittko/market-signals/platform/internal/strategy"
	"github.com/mfittko/market-signals/platform/migrations"
)

func main() {
	path := flag.String("sqlite", "../data/candles.db", "engine SQLite database to mirror (read only)")
	// Empty default: the flag package prints defaults in its usage text, which would leak the URL's password.
	dburl := flag.String("db", "", "postgres URL (default $MS_DATABASE_URL)")
	flag.Parse()
	if *dburl == "" {
		*dburl = os.Getenv("MS_DATABASE_URL")
	}
	log := slog.New(slog.NewTextHandler(os.Stderr, nil))
	if *dburl == "" {
		log.Error("MS_DATABASE_URL or -db must be set")
		os.Exit(2)
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	pool, err := db.Connect(ctx, *dburl)
	if err != nil {
		log.Error("database", "err", err)
		os.Exit(1)
	}
	defer pool.Close()
	if err := db.Migrate(ctx, pool, migrations.FS); err != nil {
		log.Error("migrate", "err", err)
		os.Exit(1)
	}
	rep, err := strategy.Mirror(ctx, pool, *path)
	if err != nil {
		log.Error("mirror", "err", err)
		os.Exit(1)
	}
	// The report names versions only, never a prompt.
	b, _ := json.MarshalIndent(rep, "", "  ")
	fmt.Println(string(b))
}
