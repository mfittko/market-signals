package api

import (
	"errors"
	"math"
	"net/http"

	"github.com/mfittko/market-signals/platform/internal/settings"
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
