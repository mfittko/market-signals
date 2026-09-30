// Package api is the control-plane HTTP surface: the operator console API, the
// engine ingest API and the authenticated worker runtime protocol.
package api

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/mfittko/market-signals/platform/fixtures"
	"github.com/mfittko/market-signals/platform/internal/queue"
	"github.com/mfittko/market-signals/platform/internal/tools"
)

type Config struct {
	WorkerToken    string
	IngestToken    string
	EngineURL      string
	AllowedOrigins []string
	// Complete answers one plain chat turn for strategy coaching. Nil when no model is configured.
	Complete func(ctx context.Context, messages []map[string]any) (string, error)
}

type Server struct {
	cfg  Config
	st   *queue.Store
	gw   *tools.Gateway
	eng  *tools.Engine
	log  *slog.Logger
	mux  *http.ServeMux
	boot time.Time
}

func New(cfg Config, st *queue.Store, log *slog.Logger) *Server {
	eng := tools.NewEngine(cfg.EngineURL)
	s := &Server{cfg: cfg, st: st, eng: eng, gw: &tools.Gateway{Store: st, Engine: eng}, log: log, mux: http.NewServeMux(), boot: time.Now()}
	s.routes()
	return s
}

func (s *Server) Handler() http.Handler { return s.hostGuard(s.originGuard(s.mux)) }

// hostName strips the port from a Host header or an Origin host.
func hostName(hostport string) string {
	if h, _, err := net.SplitHostPort(hostport); err == nil {
		return strings.Trim(h, "[]")
	}
	return strings.Trim(hostport, "[]")
}

// servedHost reports whether a Host value is a loopback name or a configured console host.
func (s *Server) servedHost(hostport string) bool {
	h := hostName(strings.TrimSpace(hostport))
	if h == "localhost" || h == "127.0.0.1" || h == "::1" {
		return true
	}
	for _, a := range s.cfg.AllowedOrigins {
		if h == hostName(a) {
			return true
		}
	}
	return false
}

// hostGuard refuses any request whose Host header is not a loopback name or a configured console
// host. A DNS-rebinding page controls both its Origin and its Host, so matching the two proves
// nothing: the Host itself must be one we serve. This covers reads as well as writes. The console
// proxy rewrites Host to the API address and forwards the page host in X-Forwarded-Host, so every
// forwarded host must pass the same check.
func (s *Server) hostGuard(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ok := s.servedHost(r.Host)
		for _, v := range r.Header.Values("X-Forwarded-Host") {
			for _, fh := range strings.Split(v, ",") {
				ok = ok && s.servedHost(fh)
			}
		}
		if !ok {
			writeJSON(w, http.StatusForbidden, map[string]any{"error": "host not allowed"})
			return
		}
		next.ServeHTTP(w, r)
	})
}

// StartReaper resolves expired leases, wakes follow-ups and expires stale queue entries.
func (s *Server) StartReaper(ctx context.Context, every time.Duration) {
	go func() {
		t := time.NewTicker(every)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				res, err := s.st.Reap(ctx)
				if err != nil && ctx.Err() == nil {
					s.log.Error("reap failed", "err", err)
				} else if res.Expired+res.Woken+res.Aged > 0 {
					s.log.Info("reaped", "expiredLeases", res.Expired, "woken", res.Woken, "expiredInQueue", res.Aged)
				}
			}
		}
	}()
}

func (s *Server) routes() {
	m := s.mux
	// operator console (loopback only; origin-guarded)
	m.HandleFunc("GET /api/v1/health", s.health)
	m.HandleFunc("GET /api/v1/agents", s.listAgents)
	m.HandleFunc("GET /api/v1/desk", s.desk)
	m.HandleFunc("GET /api/v1/instruments/{slug}", s.instrument)
	m.HandleFunc("GET /api/v1/instruments/{slug}/live", s.live)
	m.HandleFunc("GET /api/v1/instruments/{slug}/news", s.news)
	ep := s.engineProxy()
	for _, method := range []string{"GET", "POST", "DELETE"} {
		m.Handle(method+" /api/v1/engine/{path...}", ep)
	}
	m.HandleFunc("POST /api/v1/agents", s.upsertAgent)
	m.HandleFunc("PATCH /api/v1/agents/{id}", s.patchAgent)
	m.HandleFunc("GET /api/v1/strategies", s.listStrategies)
	m.HandleFunc("POST /api/v1/strategies/grill", s.grill)
	m.HandleFunc("POST /api/v1/strategies/autogrill", s.autoGrill)
	m.HandleFunc("GET /api/v1/strategies/{name}", s.getStrategy)
	m.HandleFunc("POST /api/v1/strategies/{name}/versions", s.saveVersion)
	m.HandleFunc("POST /api/v1/strategies/{name}/archive", s.setArchived)
	m.HandleFunc("POST /api/v1/strategies/{name}/versions/{version}/activate", s.activateVersion)
	m.HandleFunc("GET /api/v1/positions", s.listPositions)
	m.HandleFunc("GET /api/v1/positions/{id}", s.getPosition)
	m.HandleFunc("GET /api/v1/runs", s.listRuns)
	m.HandleFunc("GET /api/v1/runs/{id}", s.getRun)
	m.HandleFunc("GET /api/v1/runs/{id}/chart", s.runChart)
	m.HandleFunc("POST /api/v1/runs", s.triggerRun)
	m.HandleFunc("POST /api/v1/runs/{id}/cancel", s.cancelRun)
	m.HandleFunc("GET /api/v1/stream", s.stream)
	// engine ingest
	m.Handle("POST /api/v1/events", s.bearer(s.cfg.IngestToken, s.ingest))
	m.Handle("POST /api/v1/events/{key}/legacy", s.bearer(s.cfg.IngestToken, s.legacy))
	// worker runtime protocol
	m.Handle("GET /api/v1/runtime/tools", s.bearer(s.cfg.WorkerToken, s.toolDefs))
	m.Handle("POST /api/v1/runtime/claim", s.bearer(s.cfg.WorkerToken, s.claim))
	m.Handle("POST /api/v1/runtime/heartbeat", s.bearer(s.cfg.WorkerToken, s.heartbeat))
	m.Handle("POST /api/v1/runtime/events", s.bearer(s.cfg.WorkerToken, s.workerEvent))
	m.Handle("POST /api/v1/runtime/tools/call", s.bearer(s.cfg.WorkerToken, s.toolCall))
	m.Handle("POST /api/v1/runtime/complete", s.bearer(s.cfg.WorkerToken, s.complete))
	m.Handle("POST /api/v1/runtime/fail", s.bearer(s.cfg.WorkerToken, s.fail))
	m.Handle("POST /api/v1/runtime/cancelled", s.bearer(s.cfg.WorkerToken, s.cancelled))
}

// --- plumbing ---------------------------------------------------------------

func (s *Server) bearer(token string, next http.HandlerFunc) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		if token == "" || subtle.ConstantTimeCompare([]byte(got), []byte(token)) != 1 {
			writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "unauthorized"})
			return
		}
		next(w, r)
	})
}

// originGuard rejects browser requests from origins other than the console.
// Requests without an Origin header (curl, the engine, workers) pass.
func (s *Server) originGuard(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if o := r.Header.Get("Origin"); o != "" && r.Method != http.MethodGet && r.Method != http.MethodHead {
			u, err := url.Parse(o)
			ok := err == nil && (u.Host == r.Host)
			for _, a := range s.cfg.AllowedOrigins {
				if err == nil && u.Host == a {
					ok = true
				}
			}
			if !ok {
				writeJSON(w, http.StatusForbidden, map[string]any{"error": "cross-origin request refused"})
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func decode(w http.ResponseWriter, r *http.Request, v any, max int64) bool {
	r.Body = http.MaxBytesReader(w, r.Body, max)
	if err := json.NewDecoder(r.Body).Decode(v); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid JSON body: " + err.Error()})
		return false
	}
	return true
}

func (s *Server) fail500(w http.ResponseWriter, err error) {
	s.log.Error("request failed", "err", err)
	writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "internal error"})
}

// runtimeErr maps queue sentinel errors onto the worker protocol's status codes.
func (s *Server) runtimeErr(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, queue.ErrStale):
		writeJSON(w, http.StatusConflict, map[string]any{"error": "stale", "detail": err.Error()})
	case errors.Is(err, queue.ErrCancelled):
		writeJSON(w, http.StatusConflict, map[string]any{"error": "cancelled"})
	case errors.Is(err, queue.ErrForbidden):
		writeJSON(w, http.StatusForbidden, map[string]any{"error": "forbidden", "detail": err.Error()})
	case errors.Is(err, queue.ErrBudget):
		writeJSON(w, http.StatusTooManyRequests, map[string]any{"error": "budget", "detail": err.Error()})
	case errors.Is(err, queue.ErrNotFound):
		writeJSON(w, http.StatusNotFound, map[string]any{"error": "not found"})
	default:
		s.fail500(w, err)
	}
}

func pathID(r *http.Request, name string) (int64, bool) {
	n, err := strconv.ParseInt(r.PathValue(name), 10, 64)
	return n, err == nil && n > 0
}

// --- operator console -------------------------------------------------------

func (s *Server) health(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 4*time.Second)
	defer cancel()
	stats, err := s.st.Stats(ctx)
	if err != nil {
		s.fail500(w, err)
		return
	}
	engine := map[string]any{"configured": s.cfg.EngineURL != "", "reachable": false}
	if s.cfg.EngineURL != "" {
		var h map[string]any
		if err := s.eng.Get(ctx, "/api/health", nil, &h); err == nil {
			engine["reachable"] = true
		} else {
			engine["error"] = err.Error()
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "uptimeSeconds": int(time.Since(s.boot).Seconds()), "engine": engine, "stats": stats, "mode": "shadow"})
}

func (s *Server) listAgents(w http.ResponseWriter, r *http.Request) {
	as, err := s.st.ListAgents(r.Context())
	if err != nil {
		s.fail500(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"agents": as})
}

func (s *Server) upsertAgent(w http.ResponseWriter, r *http.Request) {
	var a queue.Agent
	if !decode(w, r, &a, 64<<10) {
		return
	}
	if a.ID == "" || a.Instrument == "" || a.Granularity == "" || (a.Runtime != "mock" && a.Runtime != "llm") {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "id, instrument, granularity and runtime (mock|llm) are required"})
		return
	}
	if err := a.Budgets.Check(); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	if a.Name == "" {
		a.Name = a.ID
	}
	known := map[string]bool{}
	for _, d := range tools.Definitions() {
		known[d.Name] = true
	}
	for _, t := range a.AllowedTools {
		if !known[t] {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "unknown tool " + t})
			return
		}
	}
	if a.AllowedTools == nil {
		a.AllowedTools = []string{"get_snapshot", "get_portfolio", "get_recent_candles"}
	}
	if err := s.st.UpsertAgent(r.Context(), a); err != nil {
		s.fail500(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) patchAgent(w http.ResponseWriter, r *http.Request) {
	var b struct {
		Enabled  *bool   `json:"enabled"`
		Strategy *string `json:"strategy"`
	}
	if !decode(w, r, &b, 4<<10) {
		return
	}
	if b.Enabled == nil && b.Strategy == nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "enabled or strategy is required"})
		return
	}
	if b.Strategy != nil {
		// an agent may only point at a strategy that has a live version
		// the same per-strategy lock as archiving, so an assignment cannot slip in
		// between the archive's "no agent uses it" check and its update
		var updated int64
		err := pgx.BeginFunc(r.Context(), s.st.Pool, func(tx pgx.Tx) error {
			if _, err := tx.Exec(r.Context(), `SELECT pg_advisory_xact_lock(hashtext($1))`, "strategy:"+*b.Strategy); err != nil {
				return err
			}
			tag, err := tx.Exec(r.Context(), `UPDATE agents SET strategy_name=NULLIF($1,'') WHERE id=$2 AND ($1='' OR EXISTS (SELECT 1 FROM strategies WHERE name=$1 AND NOT archived))`, *b.Strategy, r.PathValue("id"))
			updated = tag.RowsAffected()
			return err
		})
		if err != nil {
			s.fail500(w, err)
			return
		}
		if updated == 0 {
			writeJSON(w, http.StatusNotFound, map[string]any{"error": "unknown agent or strategy"})
			return
		}
	}
	if b.Enabled != nil {
		if err := s.st.SetEnabled(r.Context(), r.PathValue("id"), *b.Enabled); err != nil {
			s.runtimeErr(w, err)
			return
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) listRuns(w http.ResponseWriter, r *http.Request) {
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	runs, err := s.st.ListRuns(r.Context(), queue.RunFilter{Status: r.URL.Query().Get("status"), AgentID: r.URL.Query().Get("agent"), Limit: limit})
	if err != nil {
		s.fail500(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"runs": runs})
}

func (s *Server) getRun(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(r, "id")
	if !ok {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "bad run id"})
		return
	}
	d, err := s.st.GetRun(r.Context(), id)
	if err != nil {
		s.runtimeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, d)
}

// triggerRun is the explicit operator research trigger. source=engine builds a
// snapshot from the engine's read API; source=demo uses the bundled fixture.
func (s *Server) triggerRun(w http.ResponseWriter, r *http.Request) {
	var b struct {
		AgentID string `json:"agentId"`
		Source  string `json:"source"`
	}
	if !decode(w, r, &b, 4<<10) {
		return
	}
	agent, err := s.st.GetAgent(r.Context(), b.AgentID)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": "unknown agent"})
		return
	}
	var payload json.RawMessage
	src := "operator"
	switch b.Source {
	case "demo":
		src = "demo"
		payload, err = demoSnapshot(agent)
	default:
		payload, err = buildEngineSnapshot(r.Context(), s.eng, agent)
		if err == nil {
			payload, err = s.withStrategy(r.Context(), payload, agent)
		}
	}
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]any{"error": err.Error(), "hint": "start the engine or trigger a demo run"})
		return
	}
	res, err := s.st.Ingest(r.Context(), queue.IngestInput{
		IdemKey: fmt.Sprintf("%s-%s-%d", src, agent.ID, time.Now().UnixNano()), Instrument: agent.Instrument, Granularity: agent.Granularity,
		Event: "operator", Source: src, Trigger: "operator:" + src, Payload: payload, AgentID: agent.ID,
	})
	if err != nil {
		s.fail500(w, err)
		return
	}
	writeJSON(w, http.StatusAccepted, res)
}

func (s *Server) cancelRun(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(r, "id")
	if !ok {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "bad run id"})
		return
	}
	out, err := s.st.Cancel(r.Context(), id)
	switch {
	case errors.Is(err, queue.ErrTerminal):
		writeJSON(w, http.StatusConflict, map[string]any{"error": "run already finished", "status": out})
	case err != nil:
		s.runtimeErr(w, err)
	default:
		writeJSON(w, http.StatusOK, map[string]any{"result": out})
	}
}

// stream is a Server-Sent Events feed over the durable event log. Each frame
// carries the event id, so a reconnecting client resumes with Last-Event-ID
// and loses nothing. SSE is transport only; the queue is the source of truth.
func (s *Server) stream(w http.ResponseWriter, r *http.Request) {
	fl, ok := w.(http.Flusher)
	if !ok {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "streaming unsupported"})
		return
	}
	after := int64(-1)
	v := r.Header.Get("Last-Event-ID")
	if v == "" {
		v = r.URL.Query().Get("after")
	}
	if v != "" {
		// a malformed cursor would parse as 0 and replay the whole log
		n, err := strconv.ParseInt(v, 10, 64)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "Last-Event-ID and after must be an integer event id"})
			return
		}
		after = n
	}
	if after < 0 { // live only: start from the newest event
		st, err := s.st.Stats(r.Context())
		if err != nil {
			s.fail500(w, err)
			return
		}
		after = st.LatestEvt
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("X-Accel-Buffering", "no")
	fmt.Fprintf(w, "retry: 2000\n: connected after=%d\n\n", after)
	fl.Flush()
	poll := time.NewTicker(600 * time.Millisecond)
	ping := time.NewTicker(15 * time.Second)
	defer poll.Stop()
	defer ping.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-ping.C:
			fmt.Fprint(w, ": ping\n\n")
			fl.Flush()
		case <-poll.C:
			evs, err := s.st.EventsAfter(r.Context(), after, 200)
			if err != nil {
				return
			}
			for _, e := range evs {
				b, _ := json.Marshal(e)
				fmt.Fprintf(w, "id: %d\nevent: run\ndata: %s\n\n", e.ID, b)
				after = e.ID
			}
			if len(evs) > 0 {
				fl.Flush()
			}
		}
	}
}

// --- engine ingest ----------------------------------------------------------

func (s *Server) ingest(w http.ResponseWriter, r *http.Request) {
	var b struct {
		IdempotencyKey string          `json:"idempotencyKey"`
		Instrument     string          `json:"instrument"`
		Granularity    string          `json:"granularity"`
		Event          string          `json:"event"`
		Payload        json.RawMessage `json:"payload"`
	}
	if !decode(w, r, &b, 512<<10) {
		return
	}
	res, err := s.st.Ingest(r.Context(), queue.IngestInput{IdemKey: b.IdempotencyKey, Instrument: b.Instrument, Granularity: b.Granularity, Event: b.Event, Source: "engine", Payload: s.withIndicators(r.Context(), b.Instrument, b.Granularity, b.Payload)})
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusAccepted, res)
}

func (s *Server) legacy(w http.ResponseWriter, r *http.Request) {
	var raw json.RawMessage
	if !decode(w, r, &raw, 64<<10) {
		return
	}
	n, err := s.st.SetLegacy(r.Context(), r.PathValue("key"), raw)
	if err != nil {
		s.runtimeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"updated": n})
}

// --- worker runtime protocol ------------------------------------------------

func (s *Server) toolDefs(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"tools": tools.Definitions()})
}

func (s *Server) claim(w http.ResponseWriter, r *http.Request) {
	var b struct {
		WorkerID     string          `json:"workerId"`
		Runtimes     []string        `json:"runtimes"`
		Capabilities json.RawMessage `json:"capabilities"`
	}
	if !decode(w, r, &b, 16<<10) {
		return
	}
	if b.WorkerID == "" || len(b.Runtimes) == 0 {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "workerId and runtimes are required"})
		return
	}
	if err := s.st.RegisterWorker(r.Context(), b.WorkerID, b.Runtimes, b.Capabilities); err != nil {
		s.fail500(w, err)
		return
	}
	c, err := s.st.Claim(r.Context(), b.WorkerID, b.Runtimes, 30*time.Second)
	if err != nil {
		s.fail500(w, err)
		return
	}
	if c == nil {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	c.Agent.Budgets = c.Agent.Budgets.WithDefaults()
	writeJSON(w, http.StatusOK, c)
}

type attemptReq struct {
	AttemptID int64 `json:"attemptId"`
	Fence     int64 `json:"fence"`
}

func (s *Server) heartbeat(w http.ResponseWriter, r *http.Request) {
	var b attemptReq
	if !decode(w, r, &b, 4<<10) {
		return
	}
	cancel, err := s.st.Heartbeat(r.Context(), b.AttemptID, b.Fence, 30*time.Second)
	if err != nil {
		s.runtimeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"cancel": cancel})
}

func (s *Server) workerEvent(w http.ResponseWriter, r *http.Request) {
	var b struct {
		attemptReq
		Kind    string          `json:"kind"`
		Payload json.RawMessage `json:"payload"`
	}
	if !decode(w, r, &b, 64<<10) {
		return
	}
	cancel, err := s.st.AppendEvent(r.Context(), b.AttemptID, b.Fence, b.Kind, b.Payload)
	if err != nil {
		s.runtimeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"cancel": cancel})
}

func (s *Server) toolCall(w http.ResponseWriter, r *http.Request) {
	var b struct {
		attemptReq
		Name string          `json:"name"`
		Args json.RawMessage `json:"args"`
	}
	if !decode(w, r, &b, 64<<10) {
		return
	}
	res, err := s.gw.Call(r.Context(), b.AttemptID, b.Fence, b.Name, b.Args)
	if err != nil {
		s.runtimeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, res)
}

func (s *Server) complete(w http.ResponseWriter, r *http.Request) {
	var b struct {
		attemptReq
		queue.CompleteInput
	}
	if !decode(w, r, &b, 64<<10) {
		return
	}
	out, err := s.st.Complete(r.Context(), b.AttemptID, b.Fence, b.CompleteInput)
	if err != nil {
		s.runtimeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) fail(w http.ResponseWriter, r *http.Request) {
	var b struct {
		attemptReq
		Error     string `json:"error"`
		Retryable bool   `json:"retryable"`
	}
	if !decode(w, r, &b, 16<<10) {
		return
	}
	status, err := s.st.Fail(r.Context(), b.AttemptID, b.Fence, b.Error, b.Retryable)
	if err != nil {
		s.runtimeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"status": status})
}

func (s *Server) cancelled(w http.ResponseWriter, r *http.Request) {
	var b attemptReq
	if !decode(w, r, &b, 4<<10) {
		return
	}
	if err := s.st.AckCancel(r.Context(), b.AttemptID, b.Fence); err != nil {
		s.runtimeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

var _ = fixtures.DemoFlip

// runChart feeds the console's candle chart for one run.
func (s *Server) runChart(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(r, "id")
	if !ok {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "bad run id"})
		return
	}
	d, err := s.st.GetRun(r.Context(), id)
	if err != nil {
		s.runtimeErr(w, err)
		return
	}
	candles, source, reason, err := chartCandles(r.Context(), s.eng, d.Snapshot.Instrument, d.Snapshot.Granularity, d.Snapshot.Payload)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]any{"error": err.Error(), "hint": "the engine is not reachable and this snapshot holds no candles"})
		return
	}
	out := map[string]any{"candles": candles, "source": source}
	if reason != "" {
		out["reason"] = reason
	}
	writeJSON(w, http.StatusOK, out)
}
