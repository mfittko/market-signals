// Command worker is a separately supervised agent worker. It talks to the
// control plane only through the authenticated runtime protocol.
package main

import (
	"context"
	"flag"
	"log/slog"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/mfittko/market-signals/platform/internal/runtime"
)

func env(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}

func main() {
	api := flag.String("api", env("MS_API_URL", "http://127.0.0.1:8080"), "control plane base URL")
	id := flag.String("id", env("MS_WORKER_ID", "worker-"+hostname()), "worker id")
	conc := flag.Int("concurrency", 2, "runs executed at once")
	flag.Parse()
	log := slog.New(slog.NewTextHandler(os.Stderr, nil))
	if *conc <= 0 {
		log.Error("-concurrency must be at least 1", "got", *conc)
		os.Exit(2)
	}
	token := os.Getenv("MS_WORKER_TOKEN")
	if token == "" {
		log.Error("MS_WORKER_TOKEN must be set")
		os.Exit(2)
	}
	rts := map[string]runtime.Runtime{"mock": runtime.Mock{}}
	if os.Getenv("MS_LLM_API_KEY") != "" {
		maxTok, _ := strconv.Atoi(os.Getenv("MS_LLM_MAX_TOKENS"))
		rts["llm"] = runtime.NewLLM(runtime.LLMConfig{BaseURL: os.Getenv("MS_LLM_BASE_URL"), APIKey: os.Getenv("MS_LLM_API_KEY"), Model: os.Getenv("MS_LLM_MODEL"), MaxTokens: maxTok})
	} else {
		log.Warn("MS_LLM_API_KEY is not set: only the mock runtime is enabled")
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	w := &runtime.Worker{ID: *id, Client: runtime.NewClient(*api, token), Runtimes: rts, Concurrency: *conc, Poll: 2 * time.Second, RunTimeout: 3 * time.Minute, Log: log}
	log.Info("worker started", "id", *id, "api", *api, "runtimes", len(rts))
	w.Run(ctx)
	log.Info("worker stopped")
}

func hostname() string {
	h, _ := os.Hostname()
	return h
}
