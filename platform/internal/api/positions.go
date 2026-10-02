package api

import (
	"net/http"
	"strconv"
)

func (s *Server) listPositions(w http.ResponseWriter, r *http.Request) {
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	ps, err := s.st.ListPositions(r.Context(), r.URL.Query().Get("status"), limit)
	if err != nil {
		s.fail500(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"positions": ps})
}

func (s *Server) getPosition(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(r, "id")
	if !ok {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "bad position id"})
		return
	}
	p, ev, err := s.st.GetPosition(r.Context(), id)
	if err != nil {
		s.runtimeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"position": p, "events": ev})
}
