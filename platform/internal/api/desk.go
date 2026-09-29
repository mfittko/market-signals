package api

import (
	"net/http"
	"strings"
	"time"
)

// slug turns a symbol into a URL-safe id: WTICO/USD becomes wtico-usd.
func slug(symbol string) string { return strings.ToLower(strings.ReplaceAll(symbol, "/", "-")) }

type deskAgent struct {
	ID          string  `json:"id"`
	Name        string  `json:"name"`
	Granularity string  `json:"granularity"`
	Runtime     string  `json:"runtime"`
	Strategy    string  `json:"strategy,omitempty"`
	Enabled     bool    `json:"enabled"`
	Legacy      bool    `json:"legacy"`
	LastRunID   *int64  `json:"lastRunId,omitempty"`
	LastStatus  *string `json:"lastStatus,omitempty"`
	LastAt      *string `json:"lastAt,omitempty"`
}

type deskRow struct {
	Symbol       string      `json:"symbol"`
	Slug         string      `json:"slug"`
	Name         string      `json:"name"`
	Market       string      `json:"market"`
	Granularity  []string    `json:"granularities"`
	DataThrough  *time.Time  `json:"dataThrough,omitempty"`
	Signals      int         `json:"signals"`
	LastSignal   *string     `json:"lastSignal,omitempty"`
	LastSignalAt *time.Time  `json:"lastSignalAt,omitempty"`
	Trades       int         `json:"trades"`
	Wins         int         `json:"wins"`
	Realized     float64     `json:"realized"`
	Agents       []deskAgent `json:"agents"`
}

func (s *Server) agentsByInstrument(r *http.Request) (map[string][]deskAgent, error) {
	rows, err := s.st.Pool.Query(r.Context(), `
		SELECT a.instrument, a.id, a.name, a.granularity, a.runtime, COALESCE(a.strategy_name,''), a.enabled, a.legacy_bot,
		       lr.id, lr.status, lr.created_at::text
		FROM agents a
		LEFT JOIN LATERAL (SELECT id, status, created_at FROM runs WHERE agent_id=a.id ORDER BY id DESC LIMIT 1) lr ON true
		ORDER BY a.instrument, a.granularity, a.runtime, a.id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string][]deskAgent{}
	for rows.Next() {
		var inst string
		var a deskAgent
		if err := rows.Scan(&inst, &a.ID, &a.Name, &a.Granularity, &a.Runtime, &a.Strategy, &a.Enabled, &a.Legacy, &a.LastRunID, &a.LastStatus, &a.LastAt); err != nil {
			return nil, err
		}
		out[inst] = append(out[inst], a)
	}
	return out, rows.Err()
}

// desk lists every instrument with its data, track record and agents.
func (s *Server) desk(w http.ResponseWriter, r *http.Request) {
	ag, err := s.agentsByInstrument(r)
	if err != nil {
		s.fail500(w, err)
		return
	}
	rows, err := s.st.Pool.Query(r.Context(), `
		SELECT i.symbol, i.name, i.market,
		  COALESCE((SELECT array_agg(DISTINCT granularity ORDER BY granularity) FROM candles c WHERE c.instrument=i.symbol), '{}'),
		  (SELECT max(time) FROM candles c WHERE c.instrument=i.symbol),
		  (SELECT count(*) FROM signals s WHERE s.instrument=i.symbol),
		  ls.signal, ls.time,
		  (SELECT count(*) FROM trades t WHERE t.instrument=i.symbol),
		  (SELECT count(*) FROM trades t WHERE t.instrument=i.symbol AND t.realized>0),
		  COALESCE((SELECT sum(realized) FROM trades t WHERE t.instrument=i.symbol),0)
		FROM instruments i
		LEFT JOIN LATERAL (SELECT signal, time FROM signals s WHERE s.instrument=i.symbol ORDER BY time DESC LIMIT 1) ls ON true
		ORDER BY (SELECT count(*) FROM agents a WHERE a.instrument=i.symbol AND a.enabled) DESC, i.market, i.symbol`)
	if err != nil {
		s.fail500(w, err)
		return
	}
	defer rows.Close()
	out := []deskRow{}
	for rows.Next() {
		var d deskRow
		if err := rows.Scan(&d.Symbol, &d.Name, &d.Market, &d.Granularity, &d.DataThrough, &d.Signals, &d.LastSignal, &d.LastSignalAt, &d.Trades, &d.Wins, &d.Realized); err != nil {
			s.fail500(w, err)
			return
		}
		d.Slug = slug(d.Symbol)
		d.Agents = ag[d.Symbol]
		if d.Agents == nil {
			d.Agents = []deskAgent{}
		}
		out = append(out, d)
	}
	if err := rows.Err(); err != nil {
		s.fail500(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"instruments": out})
}

type histCandle struct {
	Time   time.Time `json:"time"`
	Open   float64   `json:"open"`
	High   float64   `json:"high"`
	Low    float64   `json:"low"`
	Close  float64   `json:"close"`
	Volume float64   `json:"volume"`
}

// instrument returns one instrument's chart window, signals and trades.
func (s *Server) instrument(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	var symbol, name, market string
	err := s.st.Pool.QueryRow(ctx, `SELECT symbol, name, market FROM instruments WHERE replace(lower(symbol),'/','-')=$1`, strings.ToLower(r.PathValue("slug"))).Scan(&symbol, &name, &market)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": "unknown instrument"})
		return
	}
	grans := []string{}
	grows, err := s.st.Pool.Query(ctx, `SELECT granularity, count(*), max(time) FROM candles WHERE instrument=$1 GROUP BY 1 ORDER BY 2 DESC`, symbol)
	if err != nil {
		s.fail500(w, err)
		return
	}
	type gran struct {
		Granularity string    `json:"granularity"`
		Candles     int       `json:"candles"`
		Last        time.Time `json:"last"`
	}
	gs := []gran{}
	for grows.Next() {
		var g gran
		if err := grows.Scan(&g.Granularity, &g.Candles, &g.Last); err != nil {
			grows.Close()
			s.fail500(w, err)
			return
		}
		gs = append(gs, g)
		grans = append(grans, g.Granularity)
	}
	grows.Close()

	chosen := r.URL.Query().Get("granularity")
	found := false
	for _, g := range grans {
		found = found || g == chosen
	}
	if !found && len(grans) > 0 {
		chosen = grans[0]
		if contains(grans, "M5") {
			chosen = "M5"
		}
	}

	candles := []histCandle{}
	if chosen != "" {
		crow, err := s.st.Pool.Query(ctx, `SELECT time, open, high, low, close, COALESCE(volume,0) FROM
			(SELECT * FROM candles WHERE instrument=$1 AND granularity=$2 ORDER BY time DESC LIMIT 120) x ORDER BY time`, symbol, chosen)
		if err != nil {
			s.fail500(w, err)
			return
		}
		for crow.Next() {
			var c histCandle
			if err := crow.Scan(&c.Time, &c.Open, &c.High, &c.Low, &c.Close, &c.Volume); err != nil {
				crow.Close()
				s.fail500(w, err)
				return
			}
			candles = append(candles, c)
		}
		crow.Close()
	}

	type sig struct {
		Granularity string    `json:"granularity"`
		Time        time.Time `json:"time"`
		Kind        string    `json:"kind"`
		Signal      string    `json:"signal"`
		Price       *float64  `json:"price"`
		Verdict     *string   `json:"verdict"`
		Reason      *string   `json:"reason"`
	}
	sigs := []sig{}
	srow, err := s.st.Pool.Query(ctx, `SELECT granularity, time, kind, signal, price, verdict, reason FROM signals WHERE instrument=$1 ORDER BY time DESC LIMIT 40`, symbol)
	if err != nil {
		s.fail500(w, err)
		return
	}
	for srow.Next() {
		var g sig
		if err := srow.Scan(&g.Granularity, &g.Time, &g.Kind, &g.Signal, &g.Price, &g.Verdict, &g.Reason); err != nil {
			srow.Close()
			s.fail500(w, err)
			return
		}
		sigs = append(sigs, g)
	}
	srow.Close()

	type trade struct {
		PositionID   int64     `json:"positionId"`
		Granularity  *string   `json:"granularity"`
		Side         string    `json:"side"`
		EntryPrice   float64   `json:"entryPrice"`
		EntryTime    time.Time `json:"entryTime"`
		ClosePrice   float64   `json:"closePrice"`
		CloseTime    time.Time `json:"closeTime"`
		Realized     float64   `json:"realized"`
		CloseReason  string    `json:"closeReason"`
		StrategyHash *string   `json:"strategyHash"`
	}
	trades := []trade{}
	trow, err := s.st.Pool.Query(ctx, `SELECT position_id, granularity, side, entry_price, entry_time, close_price, close_time, realized, close_reason, strategy_hash FROM trades WHERE instrument=$1 ORDER BY close_time DESC LIMIT 40`, symbol)
	if err != nil {
		s.fail500(w, err)
		return
	}
	for trow.Next() {
		var t trade
		if err := trow.Scan(&t.PositionID, &t.Granularity, &t.Side, &t.EntryPrice, &t.EntryTime, &t.ClosePrice, &t.CloseTime, &t.Realized, &t.CloseReason, &t.StrategyHash); err != nil {
			trow.Close()
			s.fail500(w, err)
			return
		}
		trades = append(trades, t)
	}
	trow.Close()

	ag, err := s.agentsByInstrument(r)
	if err != nil {
		s.fail500(w, err)
		return
	}
	agents := ag[symbol]
	if agents == nil {
		agents = []deskAgent{}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"symbol": symbol, "slug": slug(symbol), "name": name, "market": market,
		"granularities": gs, "granularity": chosen, "candles": candles,
		"signals": sigs, "trades": trades, "agents": agents,
	})
}

func contains(xs []string, x string) bool {
	for _, v := range xs {
		if v == x {
			return true
		}
	}
	return false
}
