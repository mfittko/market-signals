package api

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
	"time"
)

// engineRoutes is the allowlist of engine routes the console may reach through
// /api/v1/engine/. Everything else answers 404, so the proxy never becomes a
// general gateway to the engine. Secrets come back masked from the engine itself.
var engineRoutes = map[string]bool{
	"GET /settings": true, "POST /settings": true,
	"GET /threads": true, "DELETE /threads": true,
	"GET /messages": true,
	"POST /chat":    true,
	"GET /memories": true, "POST /memories": true,
	"GET /portfolio": true, "GET /signals": true,
}

// refusedSettingsKey names the first settings key the console must not write, or "". The bot
// object holds the engine paper bots' enable flags, allocation and risk, which change what the
// engine trades on the paper ledger; console agents only advise. A key ending in Bin names an
// executable the engine runs, so writing one would let the console choose code to execute.
func refusedSettingsKey(patch map[string]json.RawMessage) string {
	for k := range patch {
		if k == "bot" || strings.HasSuffix(k, "Bin") {
			return k
		}
	}
	return ""
}

// engineProxy forwards an allowlisted request to the engine. Chat replies can
// take a minute, so the response header wait is generous.
func (s *Server) engineProxy() http.Handler {
	target, err := url.Parse(s.cfg.EngineURL)
	if err != nil || s.cfg.EngineURL == "" {
		return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			writeJSON(w, http.StatusBadGateway, map[string]any{"error": "engine URL is not configured"})
		})
	}
	rp := httputil.NewSingleHostReverseProxy(target)
	rp.Transport = &http.Transport{ResponseHeaderTimeout: 180 * time.Second}
	rp.ErrorHandler = func(w http.ResponseWriter, _ *http.Request, err error) {
		writeJSON(w, http.StatusBadGateway, map[string]any{"error": "engine unreachable", "hint": err.Error()})
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sub := "/" + r.PathValue("path")
		if !engineRoutes[r.Method+" "+sub] {
			writeJSON(w, http.StatusNotFound, map[string]any{"error": "not an allowed engine route"})
			return
		}
		if r.Method == http.MethodPost && sub == "/settings" {
			body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 256<<10))
			var patch map[string]json.RawMessage
			if err != nil || json.Unmarshal(body, &patch) != nil {
				writeJSON(w, http.StatusBadRequest, map[string]any{"error": "settings must be a JSON object"})
				return
			}
			if k := refusedSettingsKey(patch); k != "" {
				writeJSON(w, http.StatusForbidden, map[string]any{"error": "the console may not write the engine setting " + k, "hint": "change it in the engine's own settings page"})
				return
			}
			r.Body = io.NopCloser(bytes.NewReader(body))
			r.ContentLength = int64(len(body))
		}
		r2 := r.Clone(r.Context())
		r2.URL.Path = "/api" + sub
		r2.Header.Del("Origin") // the engine trusts only its own origin; the console origin was checked by originGuard
		r2.Header.Del("Cookie")
		rp.ServeHTTP(w, r2)
	})
}
