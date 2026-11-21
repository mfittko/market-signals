package api

import (
	"errors"
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
	snap, changed, ok := s.writeSettings(w, r, settings.FromAPI, patch)
	if ok {
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "revision": snap.Revision, "changed": changed, "settings": settings.Masked(snap.Values)})
	}
}

// writeSettings stores patch and answers a refusal itself. ok is false when it answered.
func (s *Server) writeSettings(w http.ResponseWriter, r *http.Request, o settings.Origin, patch map[string]any) (settings.Snapshot, []string, bool) {
	snap, changed, err := settings.Write(r.Context(), s.st.Pool, o, patch)
	var pe settings.PairError
	switch {
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
	snap, changed, ok := s.writeSettings(w, r, settings.FromOperator, patch)
	if ok {
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "revision": snap.Revision, "changed": changed, "owners": jobOwners(snap.Values)})
	}
}
