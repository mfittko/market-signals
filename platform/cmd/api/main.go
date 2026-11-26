// Command api is the control-plane server: HTTP API, event stream and reaper.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/mfittko/market-signals/platform/internal/api"
	"github.com/mfittko/market-signals/platform/internal/db"
	"github.com/mfittko/market-signals/platform/internal/monitor"
	"github.com/mfittko/market-signals/platform/internal/queue"
	"github.com/mfittko/market-signals/platform/internal/research"
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
	dbURL := db.URLFlag(flag.CommandLine, "postgres URL (default $MS_DATABASE_URL; scripts/dev.sh writes it to .dev/env, or .dev/dev/env for the development stack)")
	engine := flag.String("engine", env("MS_ENGINE_URL", ""), "engine base URL for read tools and operator snapshots, e.g. http://127.0.0.1:4123")
	seed := flag.Bool("seed", false, "create the default demo agents when missing")
	flag.Parse()
	dburl := dbURL()

	log := slog.New(slog.NewTextHandler(os.Stderr, nil))
	if dburl == "" {
		log.Error("MS_DATABASE_URL or -db must be set (scripts/dev.sh writes it to .dev/env, or .dev/dev/env for the development stack)")
		os.Exit(2)
	}
	worker, ingest := os.Getenv("MS_WORKER_TOKEN"), os.Getenv("MS_INGEST_TOKEN")
	if worker == "" || ingest == "" {
		log.Error("MS_WORKER_TOKEN and MS_INGEST_TOKEN must be set (scripts/dev.sh generates them)")
		os.Exit(2)
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	err := start(ctx, log, *addr, dburl, *engine, *seed, worker, ingest)
	stop()
	// start has returned, so its deferred cleanup (pool close) already ran.
	if err != nil {
		log.Error("exiting", "err", err)
		os.Exit(1)
	}
}

// start prepares the database and the server, then hands both to run.
func start(ctx context.Context, log *slog.Logger, addr, dburl, engine string, seed bool, worker, ingest string) error {
	pool, err := db.Connect(ctx, dburl)
	if err != nil {
		return fmt.Errorf("database: %w", err)
	}
	// covers the returns before run; run closes the pool itself after its loops stop, and pool.Close is idempotent.
	defer pool.Close()
	if err := db.Migrate(ctx, pool, migrations.FS); err != nil {
		return fmt.Errorf("migrate: %w", err)
	}
	// One control plane per database: a second reaper and monitor would duplicate or reap the first one's runs.
	// The connection stays open until the process ends; os.Exit and kill -9 both end the session and the lock.
	lock, err := db.HoldStackLock(ctx, dburl, "ms-api "+addr)
	if err != nil {
		return fmt.Errorf("refusing to start: %w", err)
	}
	// A lost lock session (Postgres restart, dropped connection) would let a second control plane start beside this
	// one, so exit; the supervisor restarts the process, which retakes the lock or refuses.
	go func() {
		if err := db.WatchStackLock(ctx, lock, 5*time.Second); err != nil {
			log.Error("exiting: stack lock lost", "err", err)
			os.Exit(1)
		}
	}()
	st := queue.New(pool)
	if seed {
		if err := seedAgents(ctx, st); err != nil {
			return fmt.Errorf("seed: %w", err)
		}
	}
	cfg := api.Config{WorkerToken: worker, IngestToken: ingest, EngineURL: engine, AllowedOrigins: parseOrigins(env("MS_ALLOWED_ORIGINS", "localhost:3000,127.0.0.1:3000")), BackupDir: os.Getenv("MS_BACKUP_DIR"), OperatorToken: os.Getenv("MS_OPERATOR_TOKEN")}
	if key := os.Getenv("MS_LLM_API_KEY"); key != "" {
		maxTok, _ := strconv.Atoi(os.Getenv("MS_LLM_MAX_TOKENS"))
		cfg.Complete = runtime.NewLLM(runtime.LLMConfig{BaseURL: os.Getenv("MS_LLM_BASE_URL"), APIKey: key, Model: os.Getenv("MS_LLM_MODEL"), MaxTokens: maxTok}).Complete
	}
	srv := api.New(cfg, st, log)
	p := plane{addr: addr, log: log, handler: srv.Handler(), reaper: func(ctx context.Context) { srv.RunReaper(ctx, 3*time.Second) }, stopStreams: srv.StopStreams, close: pool.Close}
	if engine != "" {
		mon := &monitor.Service{Store: st, Feed: monitor.EngineFeed{Eng: tools.NewEngine(engine)}, Log: log, Enrich: srv.WakeEnricher()}
		p.monitor = func(ctx context.Context) { mon.Run(ctx, 15*time.Second) }
	}
	// after the stack lock, so one api writes the journal
	p.pullback = pullbackLoop(os.Getenv, pullbackSpec, log)
	log.Info("control plane starting", "addr", addr, "engine", engine)
	return run(ctx, p)
}

// plane is what run starts once the database is ready. Tests inject the loops and hooks.
type plane struct {
	addr    string
	log     *slog.Logger
	handler http.Handler
	reaper  func(context.Context) // blocks until its context ends
	monitor func(context.Context) // blocks until its context ends; nil without an engine
	// pullback blocks until its context ends; nil unless MS_PULLBACK_JOURNAL and MS_PULLBACK_START are set
	pullback func(context.Context)
	// stopStreams ends the long-lived event streams when shutdown starts; nil when the handler has none.
	stopStreams func()
	close       func()       // runs after the loops returned
	event       func(string) // records listen, reaper, monitor, pullback and serve in order; nil outside tests
}

// run binds first, so a taken port fails before any reaper, monitor or pullback pass. It then starts the loops and
// serves until ctx ends or serving fails. Shutdown ends the event streams, stops accepting, lets in-flight
// requests finish within the grace period, waits for the loops, then calls close.
func run(ctx context.Context, p plane) error {
	note := func(e string) {
		if p.event != nil {
			p.event(e)
		}
	}
	ln, err := net.Listen("tcp", p.addr)
	if err != nil {
		return fmt.Errorf("listen: %w", err)
	}
	p.log.Info("control plane listening", "addr", ln.Addr().String())
	note("listen")
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	var wg sync.WaitGroup
	for _, l := range []struct {
		name string
		loop func(context.Context)
	}{{"reaper", p.reaper}, {"monitor", p.monitor}, {"pullback", p.pullback}} {
		if l.loop == nil {
			continue
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			l.loop(ctx)
		}()
		note(l.name)
	}
	// Request contexts do not derive from ctx: a worker completion in flight at SIGTERM must finish its
	// database work. Only the event streams end at once, through stopStreams.
	hs := &http.Server{Handler: p.handler, ReadHeaderTimeout: 10 * time.Second}
	if p.stopStreams != nil {
		hs.RegisterOnShutdown(p.stopStreams)
	}
	served := make(chan error, 1)
	note("serve")
	go func() { served <- hs.Serve(ln) }()
	serveReturned := false
	select {
	case <-ctx.Done():
	case err = <-served:
		serveReturned = true
	}
	cancel()
	sc, c := context.WithTimeout(context.Background(), 5*time.Second)
	if hs.Shutdown(sc) != nil {
		// Timed out: drop the connections that handlers still hold.
		hs.Close()
	}
	c()
	if !serveReturned {
		// Serve closes ln only when it returns; wait so the address is free before run returns.
		err = <-served
	}
	wg.Wait()
	if p.close != nil {
		p.close()
	}
	if err != nil && !errors.Is(err, http.ErrServerClosed) {
		return fmt.Errorf("serve: %w", err)
	}
	return nil
}

// pullbackSpec is relative to the api's working directory, platform/, where dev.sh and the LaunchAgent start it.
const pullbackSpec = "../docs/research/experiments/pullback/spec.json"

// pullbackLoop returns the prospective pullback journal loop, which ticks hourly. It returns nil, so the api
// makes no daily fetch, unless both MS_PULLBACK_JOURNAL (the journal file) and MS_PULLBACK_START (the go-live
// time, RFC 3339) are set, or when the start or the spec does not parse.
func pullbackLoop(getenv func(string) string, specPath string, log *slog.Logger) func(context.Context) {
	path, from := getenv("MS_PULLBACK_JOURNAL"), getenv("MS_PULLBACK_START")
	if path == "" || from == "" {
		return nil
	}
	// a relative path resolves per checkout, which would fork the journal, its only state
	if !filepath.IsAbs(path) {
		log.Error("pullback journal off: MS_PULLBACK_JOURNAL must be an absolute path", "journal", path)
		return nil
	}
	start, err := time.Parse(time.RFC3339, from)
	if err != nil {
		log.Error("pullback journal off: MS_PULLBACK_START", "err", err)
		return nil
	}
	b, err := os.ReadFile(specPath)
	if err != nil {
		log.Error("pullback journal off: spec", "err", err)
		return nil
	}
	spec, err := research.ParsePullbackSpec(b)
	if err != nil {
		log.Error("pullback journal off: spec", "err", err)
		return nil
	}
	pb := &research.Pullback{Spec: spec, Feed: &research.FXEmpire{Client: &http.Client{Timeout: 25 * time.Second}}, Journal: path, Start: start, Log: log}
	log.Info("pullback journal on", "journal", path, "start", start)
	return func(ctx context.Context) { pb.Run(ctx, time.Hour) }
}

func seedAgents(ctx context.Context, st *queue.Store) error {
	have, err := st.ListAgents(ctx)
	if err != nil || len(have) > 0 {
		return err
	}
	tools := []string{"get_snapshot", "get_portfolio", "get_recent_candles", "get_recent_signals", "get_prediction", "schedule_followup"}
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
