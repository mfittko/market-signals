// Command import copies the legacy SQLite history into Postgres.
//
//	go run ./cmd/import --sqlite ../data/candles.db --settings ../data/settings.json           # dry run
//	go run ./cmd/import --sqlite ../data/candles.db --settings ../data/settings.json --commit  # write
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"sort"
	"syscall"

	"github.com/mfittko/market-signals/platform/internal/db"
	"github.com/mfittko/market-signals/platform/internal/legacy"
	"github.com/mfittko/market-signals/platform/migrations"
)

func env(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}

func main() {
	sqlite := flag.String("sqlite", "../data/candles.db", "legacy SQLite file (a private copy is read, the file is never opened)")
	settings := flag.String("settings", "../data/settings.json", "legacy settings.json (only the bot map is read)")
	symbols := flag.String("symbols", "../config/candle-symbols.json", "validated candle symbols")
	dburl := flag.String("db", env("MS_DATABASE_URL", "postgres://ms:ms@127.0.0.1:5544/ms"), "postgres URL")
	commit := flag.Bool("commit", false, "write the import. Without it the run rolls back.")
	asJSON := flag.Bool("json", false, "print the full report as JSON")
	flag.Parse()

	log := slog.New(slog.NewTextHandler(os.Stderr, nil))
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
	rep, err := legacy.Run(ctx, pool, legacy.Options{SQLitePath: *sqlite, SettingsPath: *settings, SymbolsPath: *symbols, DryRun: !*commit, Log: log})
	if err != nil {
		log.Error("import", "err", err)
		os.Exit(1)
	}
	if *asJSON {
		b, _ := json.MarshalIndent(rep, "", "  ")
		fmt.Println(string(b))
	} else {
		print(rep)
	}
	if !rep.OK() {
		os.Exit(3)
	}
}

func print(r *legacy.Report) {
	mode := "DRY RUN (rolled back)"
	if r.Committed {
		mode = "COMMITTED"
	}
	fmt.Println(mode)
	names := make([]string, 0, len(r.Tables))
	for n := range r.Tables {
		names = append(names, n)
	}
	sort.Strings(names)
	fmt.Printf("\n%-20s %10s %10s %12s\n", "table", "source", "inserted", "destination")
	for _, n := range names {
		t := r.Tables[n]
		fmt.Printf("%-20s %10d %10d %12d\n", n, t.Source, t.Inserted, t.Destination)
	}
	fmt.Printf("\ninstruments: %d, agents created: %d\n", len(r.Instruments), len(r.Agents))
	fmt.Println("\ninvariants")
	for _, c := range r.Invariants {
		mark := "ok  "
		if !c.OK {
			mark = "FAIL"
		}
		fmt.Printf("  %s %s: %s\n", mark, c.Name, c.Detail)
	}
	for _, n := range r.Notes {
		fmt.Println("note:", n)
	}
}
