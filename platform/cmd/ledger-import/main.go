// Command ledger-import copies the Node paper book into the Go paper ledger and prints the
// reconciliation report as JSON. It exits 3 when the report lists a difference. With --commit it
// writes even then, and the report's committed field shows the write.
//
//	go run ./cmd/ledger-import --book ../data/candles.db           # dry run
//	go run ./cmd/ledger-import --book ../data/candles.db --commit  # write
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
	"time"

	"github.com/mfittko/market-signals/platform/internal/db"
	"github.com/mfittko/market-signals/platform/internal/ledger"
	"github.com/mfittko/market-signals/platform/migrations"
)

func main() {
	book := flag.String("book", "", "Node paper book SQLite file (required; read once, read-only, into a private copy)")
	dburl := flag.String("db", os.Getenv("MS_DATABASE_URL"), "postgres URL (default $MS_DATABASE_URL)")
	commit := flag.Bool("commit", false, "write the import. Without it the run rolls back.")
	flag.Parse()
	log := slog.New(slog.NewTextHandler(os.Stderr, nil))
	if *book == "" {
		log.Error("--book is required")
		os.Exit(2)
	}
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
	rep, err := ledger.ImportNode(ctx, pool, *book, *commit, time.Now())
	if err != nil {
		log.Error("import", "err", err)
		os.Exit(1)
	}
	b, _ := json.MarshalIndent(rep, "", "  ")
	fmt.Println(string(b))
	if !rep.OK() {
		os.Exit(3)
	}
}
