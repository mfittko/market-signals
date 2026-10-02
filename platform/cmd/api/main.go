// Command api is the control-plane server: HTTP API, event stream and reaper.
package main

import (
	"context"
	"flag"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/mfittko/market-signals/platform/internal/api"
	"github.com/mfittko/market-signals/platform/internal/db"
	"github.com/mfittko/market-signals/platform/internal/monitor"
	"github.com/mfittko/market-signals/platform/internal/queue"
	"github.com/mfittko/market-signals/platform/internal/runtime"
	"github.com/mfittko/market-signals/platform/internal/tools"
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
	dburl := flag.String("db", os.Getenv("MS_DATABASE_URL"), "postgres URL (default $MS_DATABASE_URL; scripts/dev.sh writes it to .dev/env)")
	engine := flag.String("engine", env("MS_ENGINE_URL", ""), "engine base URL for read tools and operator snapshots, e.g. http://127.0.0.1:4123")
	seed := flag.Bool("seed", false, "create the default demo agents when missing")
	flag.Parse()

	log := slog.New(slog.NewTextHandler(os.Stderr, nil))
	if *dburl == "" {
		log.Error("MS_DATABASE_URL or -db must be set (scripts/dev.sh writes it to .dev/env)")
		os.Exit(2)
	}
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
	cfg := api.Config{WorkerToken: worker, IngestToken: ingest, EngineURL: *engine, AllowedOrigins: parseOrigins(env("MS_ALLOWED_ORIGINS", "localhost:3000,127.0.0.1:3000"))}
	if key := os.Getenv("MS_LLM_API_KEY"); key != "" {
		maxTok, _ := strconv.Atoi(os.Getenv("MS_LLM_MAX_TOKENS"))
		cfg.Complete = runtime.NewLLM(runtime.LLMConfig{BaseURL: os.Getenv("MS_LLM_BASE_URL"), APIKey: key, Model: os.Getenv("MS_LLM_MODEL"), MaxTokens: maxTok}).Complete
	}
	srv := api.New(cfg, st, log)
	srv.StartReaper(ctx, 3*time.Second)
	if *engine != "" {
		mon := &monitor.Service{Store: st, Feed: monitor.EngineFeed{Eng: tools.NewEngine(*engine)}, Log: log, Enrich: srv.WakeEnricher()}
		go mon.Run(ctx, 15*time.Second)
	}
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

// parseOrigins turns the comma-separated MS_ALLOWED_ORIGINS into host:port entries. An entry may be
// host:port or an origin such as http://host:3000; the scheme and any path are dropped.
func parseOrigins(s string) []string {
	var out []string
	for _, o := range strings.Split(s, ",") {
		o = strings.TrimSpace(o)
		if strings.Contains(o, "://") {
			if u, err := url.Parse(o); err == nil {
				o = u.Host
			}
		} else if i := strings.IndexByte(o, '/'); i >= 0 {
			o = o[:i]
		}
		if o != "" {
			out = append(out, o)
		}
	}
	return out
}
