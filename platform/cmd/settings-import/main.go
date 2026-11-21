// Command settings-import mirrors the engine's settings.json into the Go settings store.
// It is one way and idempotent: an unchanged file adds no revision. settings.json stays live.
//
//	go run ./cmd/settings-import --settings ../data/settings.json
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
	"github.com/mfittko/market-signals/platform/internal/settings"
	"github.com/mfittko/market-signals/platform/migrations"
)

func main() {
	path := flag.String("settings", "../data/settings.json", "legacy settings.json to mirror (read only)")
	dburl := flag.String("db", os.Getenv("MS_DATABASE_URL"), "postgres URL (default $MS_DATABASE_URL)")
	flag.Parse()
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
	rep, err := settings.Import(ctx, pool, *path)
	if err != nil {
		log.Error("import", "err", err)
		os.Exit(1)
	}
	// The report lists each refused key with its reason, never a value, so it is safe to print.
	b, _ := json.MarshalIndent(rep, "", "  ")
	fmt.Println(string(b))
}
