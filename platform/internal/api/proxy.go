package api

import (
	"bytes"
	"encoding/json"
	"io"
	"maps"
	"net/http"
	"net/http/httputil"
	"net/url"
	"slices"
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

// consoleSettingsKeys is the allowlist of engine settings the console Settings page writes.
// Every other key is refused. That keeps out the bot object (paper bot switches, allocation
// and risk change what the engine trades; console agents only advise), keys ending in Bin
// (an executable the engine runs), file paths such as notesFile, and any key the engine
// adds later. A new console field must be added here.
var consoleSettingsKeys = map[string]bool{
	// Chat and model
	"provider": true, "models": true, "OPENAI_BASE_URL": true, "OPENAI_API_KEY": true,
	"ANTHROPIC_API_KEY": true, "maxCompletionTokens": true,
	// Watchers
	"watchers": true,
	// Alerts
	"PUSHOVER_ENABLED": true, "PUSHOVER_USER": true, "PUSHOVER_TOKEN": true,
	// Signal filter, indicators and news
	"ind": true, "freshBars": true, "impulseVolMult": true, "impulseVolWindow": true,
	"impulseCooldownBars": true, "filterMaxCompletionTokens": true, "keepFresh": true,
	"sentinelSourceFootnotes": true, "NEWSAPI_AI_MODE": true, "GNEWS_MODE": true,
}

// refusedSettingsKeys lists, sorted, the patch keys the console may not write.
func refusedSettingsKeys(patch map[string]json.RawMessage) []string {
	var out []string
	for _, k := range slices.Sorted(maps.Keys(patch)) {
		if !consoleSettingsKeys[k] {
			out = append(out, k)
		}
	}
	return out
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
			if ks := refusedSettingsKeys(patch); len(ks) > 0 {
				writeJSON(w, http.StatusForbidden, map[string]any{"error": "the console may not write the engine settings " + strings.Join(ks, ", "), "hint": "change them in the engine's own settings page"})
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
