package api

import (
	"context"
	"errors"
	"math"
	"net"
	"net/http"
	"net/netip"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/mfittko/market-signals/platform/internal/runtime"
	"github.com/mfittko/market-signals/platform/internal/settings"
	"github.com/mfittko/market-signals/platform/internal/spend"
)

// The Go settings store is a mirror of the engine's settings.json until the console writes
// through Go. A write here does not reach the engine, and the next import overwrites it.

const maxSettingsBody = 256 << 10

func (s *Server) getSettings(w http.ResponseWriter, r *http.Request) {
	snap, err := settings.Load(r.Context(), s.st.Pool)
	if err != nil {
		s.fail500(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"revision": snap.Revision, "settings": settings.Masked(snap.Values)})
}

// localWorker answers 404 itself and returns false unless the request comes from a loopback peer without proxy
// headers. A request with proxy headers came through a proxy on the host, such as the console's.
func localWorker(w http.ResponseWriter, r *http.Request) bool {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	proxied := r.Header.Get("X-Forwarded-For") != "" || r.Header.Get("X-Forwarded-Host") != "" || r.Header.Get("Forwarded") != ""
	if ip, perr := netip.ParseAddr(host); err != nil || perr != nil || !ip.IsLoopback() || proxied {
		http.NotFound(w, r)
		return false
	}
	return true
}

// Test hooks for CapAwareLLM.
var (
	llmSettings = settings.LLM
	spendToday  = spend.Today
)

// CapAwareLLM is the per-call model config of the worker and the api's own gateway: the provider from the
// settings and whether today's model spend reached the daily cap.
func CapAwareLLM(ctx context.Context, pool *pgxpool.Pool) (runtime.ProviderConfig, error) {
	base, key, model, ok, err := llmSettings(ctx, pool)
	if err != nil {
		return runtime.ProviderConfig{}, err
	}
	spent, capUSD, err := spendToday(ctx, pool, time.Now())
	if err != nil {
		return runtime.ProviderConfig{}, err
	}
	return runtime.ProviderConfig{Configured: ok, BaseURL: base, APIKey: key, Model: model, CapReached: spend.CapReached(spent, capUSD)}, nil
}

// RecordSpend is the spend recorder of the worker route and the api's own gateway. The api prices the call.
func RecordSpend(pool *pgxpool.Pool) func(context.Context, runtime.SpendCall) error {
	return func(ctx context.Context, c runtime.SpendCall) error {
		return spend.Record(ctx, pool, spend.Call{CallSite: c.CallSite, Provider: c.Provider, Model: c.Model,
			PromptTokens: c.PromptTokens, CompletionTokens: c.CompletionTokens, Estimated: c.Estimated, RunID: c.RunID})
	}
}

// llmConfig gives the worker its model provider, key included, and the cap state for one model call. It
// answers only a local worker, so the key never leaves the host, and returns the provider fields and
// capReached and nothing else.
func (s *Server) llmConfig(w http.ResponseWriter, r *http.Request) {
	if !localWorker(w, r) {
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	cfg, err := CapAwareLLM(r.Context(), s.st.Pool)
	if err != nil {
		s.fail500(w, err)
		return
	}
	writeJSON(w, http.StatusOK, cfg)
}

// recordSpend stores one worker model call. The body carries no cost: the api prices the call from its own table.
func (s *Server) recordSpend(w http.ResponseWriter, r *http.Request) {
	if !localWorker(w, r) {
		return
	}
	var c runtime.SpendCall
	if !decode(w, r, &c, 4<<10) {
		return
	}
	// a padded value would be stored as a call site or model of its own
	bad := func(v string) bool { return v == "" || strings.TrimSpace(v) != v }
	if bad(c.CallSite) || bad(c.Model) || c.PromptTokens < 0 || c.CompletionTokens < 0 {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "callSite and model are required without surrounding spaces and token counts must be >= 0"})
		return
	}
	if err := RecordSpend(s.st.Pool)(r.Context(), c); err != nil {
		s.fail500(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) patchSettings(w http.ResponseWriter, r *http.Request) {
	var patch map[string]any
	if !decode(w, r, &patch, maxSettingsBody) {
		return
	}
	// baseRevision is the revision the edit is based on (platform/docs/write-preconditions.md).
	// A missing one counts as 0, so a write may omit it only while the current revision is 0.
	raw, sent := patch["baseRevision"]
	delete(patch, "baseRevision")
	f, isNum := raw.(float64)
	// A JSON number decodes as float64, which holds integers exactly only up to 2^53-1.
	if sent && (!isNum || f < 0 || f != math.Trunc(f) || f > 1<<53-1) {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "baseRevision must be a non-negative integer", "code": "invalid_setting"})
		return
	}
	base := int64(f)
	snap, changed, ok := s.writeSettings(w, r, settings.FromAPI, patch, &base, sent)
	if ok {
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "revision": snap.Revision, "changed": changed, "settings": settings.Masked(snap.Values)})
	}
}

// writeSettings stores patch and answers a refusal itself. ok is false when it answered.
// A nil base skips the revision check; sent tells whether the caller named the base.
func (s *Server) writeSettings(w http.ResponseWriter, r *http.Request, o settings.Origin, patch map[string]any, base *int64, sent bool) (settings.Snapshot, []string, bool) {
	snap, changed, err := settings.Write(r.Context(), s.st.Pool, o, patch, base)
	var pe settings.PairError
	var stale settings.StaleError
	switch {
	case errors.As(err, &stale) && !sent:
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "baseRevision is required once the settings revision is above 0",
			"hint": "send the revision you loaded", "code": "base_revision_required"})
	case errors.As(err, &stale):
		writeJSON(w, http.StatusConflict, map[string]any{"error": "another tab or client changed the settings",
			"hint": "reload to see the current settings", "code": "stale_base_revision", "currentRevision": stale.Current})
	case errors.Is(err, settings.ErrInvalid):
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error(), "code": "invalid_setting"})
	case errors.As(err, &pe):
		writeJSON(w, http.StatusConflict, map[string]any{"error": err.Error(), "code": "bot_needs_pair", "pairs": pe.Pairs})
	case err != nil:
		s.fail500(w, err)
	default:
		return snap, changed, true
	}
	return snap, changed, false
}

// jobOwners reports each job kind's owner. An unset flag reads as "node", because Go jobs ship disabled.
func jobOwners(vals map[string]any) map[string]any {
	out := map[string]any{}
	for _, k := range settings.JobKinds {
		out[k] = "node"
		if v, ok := vals[settings.JobOwnerKey(k)]; ok {
			out[k] = v
		}
	}
	return out
}

func (s *Server) getJobOwners(w http.ResponseWriter, r *http.Request) {
	snap, err := settings.Load(r.Context(), s.st.Pool)
	if err != nil {
		s.fail500(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"revision": snap.Revision, "owners": jobOwners(snap.Values)})
}

// putJobOwners sets owner flags by job kind, e.g. {"bot": "go"}. An unknown kind is refused.
func (s *Server) putJobOwners(w http.ResponseWriter, r *http.Request) {
	var body map[string]any
	if !decode(w, r, &body, 4<<10) {
		return
	}
	patch := map[string]any{}
	for kind, v := range body {
		patch[settings.JobOwnerKey(kind)] = v
	}
	snap, changed, ok := s.writeSettings(w, r, settings.FromOperator, patch, nil, false)
	if ok {
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "revision": snap.Revision, "changed": changed, "owners": jobOwners(snap.Values)})
	}
}
