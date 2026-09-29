// Command api is the control-plane server: HTTP API, event stream and reaper.
package main

import (
	"context"
	"flag"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/mfittko/market-signals/platform/internal/api"
	"github.com/mfittko/market-signals/platform/internal/db"
	"github.com/mfittko/market-signals/platform/internal/queue"
	"github.com/mfittko/market-signals/platform/migrations"
)

func env(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}

func main() {
	addr := flag.String("addr", env("MS_API_ADDR", "127.0.0.1:8080"), "listen address (keep it on loopback)")
	dburl := flag.String("db", env("MS_DATABASE_URL", "postgres://ms:ms@127.0.0.1:5544/ms"), "postgres URL")
	engine := flag.String("engine", env("MS_ENGINE_URL", ""), "engine base URL for read tools and operator snapshots, e.g. http://127.0.0.1:4123")
	seed := flag.Bool("seed", true, "create the default demo agents when missing")
	flag.Parse()

	log := slog.New(slog.NewTextHandler(os.Stderr, nil))
	worker, ingest := os.Getenv("MS_WORKER_TOKEN"), os.Getenv("MS_INGEST_TOKEN")
	if worker == "" || ingest == "" {
		log.Error("MS_WORKER_TOKEN and MS_INGEST_TOKEN must be set (scripts/dev.sh generates them)")
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
	st := queue.New(pool)
	if *seed {
		if err := seedAgents(ctx, st); err != nil {
			log.Error("seed", "err", err)
			os.Exit(1)
		}
	}
	origins := strings.Split(env("MS_ALLOWED_ORIGINS", "localhost:3000,127.0.0.1:3000"), ",")
	srv := api.New(api.Config{WorkerToken: worker, IngestToken: ingest, EngineURL: *engine, AllowedOrigins: origins}, st, log)
	srv.StartReaper(ctx, 3*time.Second)
	hs := &http.Server{Addr: *addr, Handler: srv.Handler(), ReadHeaderTimeout: 10 * time.Second}
	go func() {
		<-ctx.Done()
		sc, c := context.WithTimeout(context.Background(), 5*time.Second)
		defer c()
		_ = hs.Shutdown(sc)
	}()
	log.Info("control plane listening", "addr", *addr, "engine", *engine)
	if err := hs.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Error("serve", "err", err)
		os.Exit(1)
	}
}

func seedAgents(ctx context.Context, st *queue.Store) error {
	have, err := st.ListAgents(ctx)
	if err != nil || len(have) > 0 {
		return err
	}
	tools := []string{"get_snapshot", "get_portfolio", "get_recent_candles", "get_recent_signals", "schedule_followup"}
	for _, a := range []queue.Agent{
		{ID: "wti-m5-mock", Name: "WTI M5 (deterministic mock)", Instrument: "WTICO/USD", Granularity: "M5", Runtime: "mock", AllowedTools: tools, Enabled: true},
		{ID: "wti-m5-llm", Name: "WTI M5 (LLM research)", Instrument: "WTICO/USD", Granularity: "M5", Runtime: "llm", AllowedTools: tools, Enabled: true},
	} {
		if err := st.UpsertAgent(ctx, a); err != nil {
			return err
		}
	}
	return nil
}
