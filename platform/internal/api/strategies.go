package api

import (
	"errors"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

// Strategies are versioned prompts. An agent judges entries with the active
// version of the strategy it points at. Saving an edit adds a version and makes
// it active; older versions stay readable, so a change is always reversible.
// These rows live in the console database only. The live engine keeps its own.

const maxPrompt = 32 << 10

var errArchived = errors.New("strategy is archived")

var strategyName = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9 _.\-]{0,63}$`)

type strategySummary struct {
	Name          string    `json:"name"`
	ActiveVersion *int      `json:"activeVersion"`
	Versions      int       `json:"versions"`
	Agents        int       `json:"agents"`
	Archived      bool      `json:"archived"`
	UpdatedAt     time.Time `json:"updatedAt"`
}

func (s *Server) listStrategies(w http.ResponseWriter, r *http.Request) {
	rows, err := s.st.Pool.Query(r.Context(), `
		SELECT st.name,
		  max(st.version) FILTER (WHERE st.active AND NOT st.archived),
		  count(*),
		  (SELECT count(*) FROM agents a WHERE a.strategy_name = st.name),
		  max(st.created_at), bool_and(st.archived)
		FROM strategies st GROUP BY st.name
		ORDER BY st.name`)
	if err != nil {
		s.fail500(w, err)
		return
	}
	defer rows.Close()
	out := []strategySummary{}
	for rows.Next() {
		var x strategySummary
		if err := rows.Scan(&x.Name, &x.ActiveVersion, &x.Versions, &x.Agents, &x.UpdatedAt, &x.Archived); err != nil {
			s.fail500(w, err)
			return
		}
		out = append(out, x)
	}
	if err := rows.Err(); err != nil {
		s.fail500(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"strategies": out})
}

type strategyVersion struct {
	Version   int       `json:"version"`
	Prompt    string    `json:"prompt"`
	Active    bool      `json:"active"`
	CreatedBy string    `json:"createdBy"`
	CreatedAt time.Time `json:"createdAt"`
}

func (s *Server) getStrategy(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	rows, err := s.st.Pool.Query(r.Context(),
		`SELECT version, prompt, active, created_by, created_at FROM strategies WHERE name=$1 ORDER BY version DESC`, name)
	if err != nil {
		s.fail500(w, err)
		return
	}
	defer rows.Close()
	out := []strategyVersion{}
	for rows.Next() {
		var v strategyVersion
		if err := rows.Scan(&v.Version, &v.Prompt, &v.Active, &v.CreatedBy, &v.CreatedAt); err != nil {
			s.fail500(w, err)
			return
		}
		out = append(out, v)
	}
	if err := rows.Err(); err != nil {
		s.fail500(w, err)
		return
	}
	if len(out) == 0 {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": "no such strategy"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"name": name, "versions": out})
}

// saveVersion adds a version and makes it the only active one. Posting to a new
// name creates the strategy at version 1. Scope columns are copied from the
// previous version so the edit keeps its instrument and timeframe.
func (s *Server) saveVersion(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	var b struct {
		Prompt      string `json:"prompt"`
		Instrument  string `json:"instrument"`  // scope for a brand new strategy
		Granularity string `json:"granularity"` // ignored when an earlier version exists
	}
	if !decode(w, r, &b, maxPrompt+1024) {
		return
	}
	b.Prompt = strings.TrimSpace(b.Prompt)
	switch {
	case !strategyName.MatchString(name):
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "name: letters, digits, space, dot, dash or underscore, up to 64"})
		return
	case b.Prompt == "":
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "prompt is empty"})
		return
	case len(b.Prompt) > maxPrompt:
		writeJSON(w, http.StatusRequestEntityTooLarge, map[string]any{"error": "prompt is over 32 KB"})
		return
	}
	var version int
	err := pgx.BeginFunc(r.Context(), s.st.Pool, func(tx pgx.Tx) error {
		// serialize concurrent saves of one strategy so versions stay unique and one is active
		if _, err := tx.Exec(r.Context(), `SELECT pg_advisory_xact_lock(hashtext($1))`, "strategy:"+name); err != nil {
			return err
		}
		var archived bool
		if err := tx.QueryRow(r.Context(), `SELECT COALESCE(bool_or(archived),false) FROM strategies WHERE name=$1`, name).Scan(&archived); err != nil {
			return err
		}
		if archived {
			return errArchived
		}
		if _, err := tx.Exec(r.Context(), `UPDATE strategies SET active=false WHERE name=$1`, name); err != nil {
			return err
		}
		return tx.QueryRow(r.Context(), `
			INSERT INTO strategies (name,version,prompt,spec,instruments,created_by,created_at,active,archived,instrument,granularity,dedicated)
			SELECT $1, COALESCE((SELECT max(version) FROM strategies WHERE name=$1),0)+1, $2,
			  p.spec, p.instruments, 'console', now(), true, false, COALESCE(p.instrument, NULLIF($3,'')), COALESCE(p.granularity, NULLIF($4,'')), COALESCE(p.dedicated, $3 <> '')
			FROM (SELECT 1) one
			LEFT JOIN LATERAL (SELECT * FROM strategies WHERE name=$1 ORDER BY version DESC LIMIT 1) p ON true
			RETURNING version`, name, b.Prompt, b.Instrument, b.Granularity).Scan(&version)
	})
	if errors.Is(err, errArchived) {
		writeJSON(w, http.StatusConflict, map[string]any{"error": "this strategy is archived; restore it before editing"})
		return
	}
	if err != nil {
		s.fail500(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "name": name, "version": version})
}

// activateVersion makes an existing version the active one again (rollback).
func (s *Server) activateVersion(w http.ResponseWriter, r *http.Request) {
	name, ver := r.PathValue("name"), r.PathValue("version")
	var n int
	err := pgx.BeginFunc(r.Context(), s.st.Pool, func(tx pgx.Tx) error {
		if _, err := tx.Exec(r.Context(), `SELECT pg_advisory_xact_lock(hashtext($1))`, "strategy:"+name); err != nil {
			return err
		}
		if err := tx.QueryRow(r.Context(), `SELECT count(*) FROM strategies WHERE name=$1 AND version=$2::int AND NOT archived`, name, ver).Scan(&n); err != nil || n == 0 {
			return err
		}
		if _, err := tx.Exec(r.Context(), `UPDATE strategies SET active=false WHERE name=$1`, name); err != nil {
			return err
		}
		_, err := tx.Exec(r.Context(), `UPDATE strategies SET active=true WHERE name=$1 AND version=$2::int`, name, ver)
		return err
	})
	if err != nil {
		s.fail500(w, err)
		return
	}
	if n == 0 {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": "no such version"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// archived retires a strategy: every version is archived, so no snapshot uses it and
// the console hides it by default. It is refused while an agent still points at it,
// so a live agent never loses its rules by accident. Restore reverses it.
func (s *Server) setArchived(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	var b struct {
		Archived *bool `json:"archived"`
	}
	if !decode(w, r, &b, 1<<10) {
		return
	}
	if b.Archived == nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "archived is required"})
		return
	}
	var agents, rows int
	err := pgx.BeginFunc(r.Context(), s.st.Pool, func(tx pgx.Tx) error {
		if _, err := tx.Exec(r.Context(), `SELECT pg_advisory_xact_lock(hashtext($1))`, "strategy:"+name); err != nil {
			return err
		}
		if err := tx.QueryRow(r.Context(), `SELECT count(*) FROM strategies WHERE name=$1`, name).Scan(&rows); err != nil || rows == 0 {
			return err
		}
		if *b.Archived {
			if err := tx.QueryRow(r.Context(), `SELECT count(*) FROM agents WHERE strategy_name=$1`, name).Scan(&agents); err != nil || agents > 0 {
				return err
			}
		}
		_, err := tx.Exec(r.Context(), `UPDATE strategies SET archived=$2 WHERE name=$1`, name, *b.Archived)
		return err
	})
	switch {
	case err != nil:
		s.fail500(w, err)
	case rows == 0:
		writeJSON(w, http.StatusNotFound, map[string]any{"error": "no such strategy"})
	case agents > 0:
		writeJSON(w, http.StatusConflict, map[string]any{"error": "agents still use this strategy; assign them another one first", "agents": agents})
	default:
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	}
}
