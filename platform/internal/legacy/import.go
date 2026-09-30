// Package legacy imports the history of the SQLite engine into Postgres.
//
// The importer reads a private copy of the source file, writes everything in one
// transaction and proves a list of invariants before it commits. A dry run
// executes the same code and rolls back. Every table uses natural or source keys
// with ON CONFLICT DO NOTHING, so a re-run only adds what is new.
package legacy

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"maps"
	"math"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	_ "modernc.org/sqlite"
)

type Options struct {
	SQLitePath   string // legacy candles.db (holds every table)
	SettingsPath string // legacy settings.json; only the bot map is read
	SymbolsPath  string // config/candle-symbols.json
	DryRun       bool
	Log          *slog.Logger
}

type TableReport struct {
	Source      int `json:"source"`
	Inserted    int `json:"inserted"`
	Destination int `json:"destination"`
}

type Check struct {
	Name   string `json:"name"`
	OK     bool   `json:"ok"`
	Detail string `json:"detail"`
}

type Report struct {
	DryRun      bool                   `json:"dryRun"`
	Committed   bool                   `json:"committed"`
	Tables      map[string]TableReport `json:"tables"`
	Instruments []string               `json:"instruments"`
	Agents      []string               `json:"agents"`
	Invariants  []Check                `json:"invariants"`
	Notes       []string               `json:"notes"`
}

func (r *Report) OK() bool {
	for _, c := range r.Invariants {
		if !c.OK {
			return false
		}
	}
	return true
}

func (r *Report) check(name string, ok bool, format string, a ...any) {
	r.Invariants = append(r.Invariants, Check{Name: name, OK: ok, Detail: fmt.Sprintf(format, a...)})
}

func Run(ctx context.Context, pool *pgxpool.Pool, o Options) (*Report, error) {
	if o.Log == nil {
		o.Log = slog.New(slog.NewTextHandler(io.Discard, nil))
	}
	src, cleanup, err := openCopy(o.SQLitePath)
	if err != nil {
		return nil, err
	}
	defer cleanup()

	tx, err := pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	rep := &Report{DryRun: o.DryRun, Tables: map[string]TableReport{}}
	im := &importer{ctx: ctx, tx: tx, src: src, rep: rep, log: o.Log}

	steps := []struct {
		name string
		fn   func() error
	}{
		{"candles", im.candles},
		{"signals", im.signals},
		{"signal_snapshots", im.signalSnapshots},
		{"strategies", im.strategies},
		{"trades", im.trades},
		{"bot_journal", im.journal},
		{"portfolio_account", im.portfolio},
		{"chat", im.chat},
		{"standing_rules", im.rules},
		{"prompt_versions", im.prompts},
		{"rechecks", im.rechecks},
	}
	for _, s := range steps {
		start := time.Now()
		if err := s.fn(); err != nil {
			return nil, fmt.Errorf("import %s: %w", s.name, err)
		}
		o.Log.Info("imported", "step", s.name, "took", time.Since(start).Round(time.Millisecond))
	}
	if err := im.instrumentsAndAgents(o); err != nil {
		return nil, fmt.Errorf("instruments and agents: %w", err)
	}
	if err := im.invariants(o); err != nil {
		return nil, fmt.Errorf("invariants: %w", err)
	}

	if o.DryRun || !rep.OK() {
		if !o.DryRun {
			rep.Notes = append(rep.Notes, "an invariant failed: nothing was committed")
		}
		_ = tx.Rollback(ctx)
	} else {
		if err := tx.Commit(ctx); err != nil {
			return nil, err
		}
		rep.Committed = true
	}
	b, _ := json.Marshal(rep)
	_, _ = pool.Exec(ctx, `INSERT INTO import_runs (source, dry_run, report) VALUES ($1,$2,$3)`, filepath.Base(o.SQLitePath), o.DryRun, b)
	return rep, nil
}

type importer struct {
	ctx context.Context
	tx  pgx.Tx
	src *sql.DB
	rep *Report
	log *slog.Logger
}

// openCopy copies the database (and its write-ahead log) so the live file is
// never opened by the importer.
func openCopy(path string) (*sql.DB, func(), error) {
	dir, err := os.MkdirTemp("", "ms-import-")
	if err != nil {
		return nil, nil, err
	}
	cleanup := func() { _ = os.RemoveAll(dir) }
	for _, suffix := range []string{"", "-wal", "-shm"} {
		if err := copyFile(path+suffix, filepath.Join(dir, "src.db"+suffix)); err != nil && !(suffix != "" && errors.Is(err, os.ErrNotExist)) {
			cleanup()
			return nil, nil, err
		}
	}
	db, err := sql.Open("sqlite", "file:"+filepath.Join(dir, "src.db")+"?mode=ro")
	if err != nil {
		cleanup()
		return nil, nil, err
	}
	return db, func() { db.Close(); cleanup() }, nil
}

func copyFile(from, to string) error {
	in, err := os.Open(from)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.Create(to)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}

var timeLayouts = []string{time.RFC3339Nano, "2006-01-02T15:04:05.000Z", "2006-01-02 15:04:05", "2006-01-02T15:04:05Z"}

func parseTime(s string) (time.Time, error) {
	for _, l := range timeLayouts {
		if t, err := time.Parse(l, s); err == nil {
			return t.UTC(), nil
		}
	}
	return time.Time{}, fmt.Errorf("unrecognised time %q", s)
}

func nullJSON(s sql.NullString) any {
	if !s.Valid || strings.TrimSpace(s.String) == "" {
		return nil
	}
	if !json.Valid([]byte(s.String)) { // keep unparseable text instead of failing the import
		b, _ := json.Marshal(s.String)
		return string(b)
	}
	return s.String
}

func (im *importer) count(table string) (int, error) {
	var n int
	err := im.tx.QueryRow(im.ctx, `SELECT count(*) FROM `+table).Scan(&n)
	return n, err
}

func (im *importer) srcCount(q string) (int, error) {
	var n int
	err := im.src.QueryRowContext(im.ctx, q).Scan(&n)
	return n, err
}

// finish records source, inserted and destination counts for one table.
func (im *importer) finish(name, dstTable, srcQuery string, inserted int) error {
	s, err := im.srcCount(srcQuery)
	if err != nil {
		return err
	}
	d, err := im.count(dstTable)
	if err != nil {
		return err
	}
	im.rep.Tables[name] = TableReport{Source: s, Inserted: inserted, Destination: d}
	return nil
}

func (im *importer) candles() error {
	if _, err := im.tx.Exec(im.ctx, `CREATE TEMP TABLE _candles_stage (LIKE candles) ON COMMIT DROP`); err != nil {
		return err
	}
	rows, err := im.src.QueryContext(im.ctx, `SELECT instrument, granularity, time, open, high, low, close, volume FROM candles`)
	if err != nil {
		return err
	}
	defer rows.Close()
	var bad int
	src := pgx.CopyFromFunc(func() ([]any, error) {
		for rows.Next() {
			var inst, gran, ts string
			var o, h, l, c float64
			var v sql.NullFloat64
			if err := rows.Scan(&inst, &gran, &ts, &o, &h, &l, &c, &v); err != nil {
				return nil, err
			}
			t, err := parseTime(ts)
			if err != nil {
				bad++
				continue
			}
			var vol any
			if v.Valid {
				vol = v.Float64
			}
			return []any{inst, gran, t, o, h, l, c, vol}, nil
		}
		return nil, rows.Err()
	})
	if _, err := im.tx.CopyFrom(im.ctx, pgx.Identifier{"_candles_stage"}, []string{"instrument", "granularity", "time", "open", "high", "low", "close", "volume"}, src); err != nil {
		return err
	}
	tag, err := im.tx.Exec(im.ctx, `INSERT INTO candles SELECT * FROM _candles_stage ON CONFLICT DO NOTHING`)
	if err != nil {
		return err
	}
	if bad > 0 {
		im.rep.Notes = append(im.rep.Notes, fmt.Sprintf("candles: %d rows skipped for an unreadable time", bad))
	}
	return im.finish("candles", "candles", `SELECT count(*) FROM candles`, int(tag.RowsAffected()))
}

func (im *importer) signals() error {
	rows, err := im.src.QueryContext(im.ctx, `SELECT instrument, granularity, time, kind, signal, price, win_rate, verdict, reason, COALESCE(notified,0) FROM signals`)
	if err != nil {
		return err
	}
	defer rows.Close()
	b := &pgx.Batch{}
	for rows.Next() {
		var inst, gran, ts, kind, sig string
		var price, win sql.NullFloat64
		var verdict, reason sql.NullString
		var notified int
		if err := rows.Scan(&inst, &gran, &ts, &kind, &sig, &price, &win, &verdict, &reason, &notified); err != nil {
			return err
		}
		t, err := parseTime(ts)
		if err != nil {
			return err
		}
		b.Queue(`INSERT INTO signals (instrument,granularity,time,kind,signal,price,win_rate,verdict,reason,notified)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING`,
			inst, gran, t, kind, sig, nf(price), nf(win), ns(verdict), ns(reason), notified != 0)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	n, err := im.send(b)
	if err != nil {
		return err
	}
	return im.finish("signals", "signals", `SELECT count(*) FROM signals`, n)
}

func (im *importer) signalSnapshots() error {
	rows, err := im.src.QueryContext(im.ctx, `SELECT instrument, granularity, time, schema_version, snapshot, filter_verdict, filter_model, filter_prompt_hash, filter_prompt_version, context FROM signal_snapshots`)
	if err != nil {
		return err
	}
	defer rows.Close()
	b := &pgx.Batch{}
	for rows.Next() {
		var inst, gran, ts string
		var ver int
		var snap string
		var fv, fm, fh, fpv, ctxt sql.NullString
		if err := rows.Scan(&inst, &gran, &ts, &ver, &snap, &fv, &fm, &fh, &fpv, &ctxt); err != nil {
			return err
		}
		t, err := parseTime(ts)
		if err != nil {
			return err
		}
		b.Queue(`INSERT INTO signal_snapshots (instrument,granularity,time,schema_version,snapshot,filter_verdict,filter_model,filter_prompt_hash,filter_prompt_version,context)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING`,
			inst, gran, t, ver, nullJSON(sql.NullString{String: snap, Valid: true}), ns(fv), ns(fm), ns(fh), ns(fpv), nullJSON(ctxt))
	}
	if err := rows.Err(); err != nil {
		return err
	}
	n, err := im.send(b)
	if err != nil {
		return err
	}
	return im.finish("signal_snapshots", "signal_snapshots", `SELECT count(*) FROM signal_snapshots`, n)
}

func (im *importer) strategies() error {
	rows, err := im.src.QueryContext(im.ctx, `SELECT name, version, prompt, spec, instruments, created_by, created_at, active, archived, instrument, granularity, dedicated FROM strategies`)
	if err != nil {
		return err
	}
	defer rows.Close()
	b := &pgx.Batch{}
	for rows.Next() {
		var name, prompt, by, created string
		var version, active, archived, dedicated int
		var spec, insts, inst, gran sql.NullString
		if err := rows.Scan(&name, &version, &prompt, &spec, &insts, &by, &created, &active, &archived, &inst, &gran, &dedicated); err != nil {
			return err
		}
		t, err := parseTime(created)
		if err != nil {
			return err
		}
		b.Queue(`INSERT INTO strategies (name,version,prompt,spec,instruments,created_by,created_at,active,archived,instrument,granularity,dedicated)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT DO NOTHING`,
			name, version, prompt, nullJSON(spec), ns(insts), by, t, active != 0, archived != 0, ns(inst), ns(gran), dedicated != 0)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	n, err := im.send(b)
	if err != nil {
		return err
	}
	return im.finish("strategies", "strategies", `SELECT count(*) FROM strategies`, n)
}

// trades also links each trade to the strategy version recorded when its
// position opened (the journal's open entry carries a strategyVersion hash).
func (im *importer) trades() error {
	hashes := map[int64]string{}
	jr, err := im.src.QueryContext(im.ctx, `SELECT position_id, context FROM bot_journal WHERE action='open' AND position_id IS NOT NULL`)
	if err != nil {
		return err
	}
	for jr.Next() {
		var pid int64
		var c sql.NullString
		if err := jr.Scan(&pid, &c); err != nil {
			jr.Close()
			return err
		}
		var v struct {
			StrategyVersion string `json:"strategyVersion"`
		}
		if c.Valid && json.Unmarshal([]byte(c.String), &v) == nil && v.StrategyVersion != "" {
			hashes[pid] = v.StrategyVersion
		}
	}
	jr.Close()

	rows, err := im.src.QueryContext(im.ctx, `SELECT id, position_id, instrument, granularity, side, notional, units, entry_price, entry_time, close_price, close_time, leverage, realized, close_reason FROM bot_trades`)
	if err != nil {
		return err
	}
	defer rows.Close()
	b := &pgx.Batch{}
	for rows.Next() {
		var id, pid int64
		var inst, side, et, ct, reason string
		var gran sql.NullString
		var notional, units, ep, cp, lev, realized float64
		if err := rows.Scan(&id, &pid, &inst, &gran, &side, &notional, &units, &ep, &et, &cp, &ct, &lev, &realized, &reason); err != nil {
			return err
		}
		entry, err := parseTime(et)
		if err != nil {
			return err
		}
		closed, err := parseTime(ct)
		if err != nil {
			return err
		}
		var h any
		if v, ok := hashes[pid]; ok {
			h = v
		}
		b.Queue(`INSERT INTO trades (source_key,position_id,instrument,granularity,side,notional,units,entry_price,entry_time,close_price,close_time,leverage,realized,close_reason,strategy_hash)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) ON CONFLICT DO NOTHING`,
			fmt.Sprintf("trade:%d", id), pid, inst, ns(gran), side, notional, units, ep, entry, cp, closed, lev, realized, reason, h)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	n, err := im.send(b)
	if err != nil {
		return err
	}
	return im.finish("trades", "trades", `SELECT count(*) FROM bot_trades`, n)
}

func (im *importer) journal() error {
	rows, err := im.src.QueryContext(im.ctx, `SELECT id, at, action, position_id, reason, context FROM bot_journal`)
	if err != nil {
		return err
	}
	defer rows.Close()
	b := &pgx.Batch{}
	for rows.Next() {
		var id int64
		var at, action string
		var pid sql.NullInt64
		var reason, c sql.NullString
		if err := rows.Scan(&id, &at, &action, &pid, &reason, &c); err != nil {
			return err
		}
		t, err := parseTime(at)
		if err != nil {
			return err
		}
		var p any
		if pid.Valid {
			p = pid.Int64
		}
		b.Queue(`INSERT INTO bot_journal (source_key,at,action,position_id,reason,context) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
			fmt.Sprintf("journal:%d", id), t, action, p, ns(reason), nullJSON(c))
	}
	if err := rows.Err(); err != nil {
		return err
	}
	n, err := im.send(b)
	if err != nil {
		return err
	}
	return im.finish("bot_journal", "bot_journal", `SELECT count(*) FROM bot_journal`, n)
}

func (im *importer) portfolio() error {
	var start, cash float64
	var halted int
	var created string
	if err := im.src.QueryRowContext(im.ctx, `SELECT starting_balance, cash, halted, created_at FROM portfolio WHERE id=1`).Scan(&start, &cash, &halted, &created); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			im.rep.Notes = append(im.rep.Notes, "no portfolio row in the source")
			return nil
		}
		return err
	}
	t, err := parseTime(created)
	if err != nil {
		return err
	}
	var peak sql.NullFloat64
	_ = im.src.QueryRowContext(im.ctx, `SELECT value FROM bot_state WHERE key='peak_equity'`).Scan(&peak)
	tag, err := im.tx.Exec(im.ctx, `INSERT INTO portfolio_account (id,starting_balance,cash,halted,peak_equity,created_at) VALUES (1,$1,$2,$3,$4,$5)
		ON CONFLICT (id) DO UPDATE SET cash=EXCLUDED.cash, halted=EXCLUDED.halted, peak_equity=EXCLUDED.peak_equity
		WHERE (portfolio_account.cash, portfolio_account.halted, portfolio_account.peak_equity) IS DISTINCT FROM (EXCLUDED.cash, EXCLUDED.halted, EXCLUDED.peak_equity)`,
		start, cash, halted != 0, nf(peak), t)
	if err != nil {
		return err
	}
	return im.finish("portfolio_account", "portfolio_account", `SELECT count(*) FROM portfolio`, int(tag.RowsAffected()))
}

func (im *importer) chat() error {
	rows, err := im.src.QueryContext(im.ctx, `SELECT id, title, instrument, granularity, created_at FROM chat_threads`)
	if err != nil {
		return err
	}
	b := &pgx.Batch{}
	for rows.Next() {
		var id int64
		var title, created string
		var inst, gran sql.NullString
		if err := rows.Scan(&id, &title, &inst, &gran, &created); err != nil {
			rows.Close()
			return err
		}
		t, err := parseTime(created)
		if err != nil {
			rows.Close()
			return err
		}
		b.Queue(`INSERT INTO chat_threads (source_key,title,instrument,granularity,created_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
			fmt.Sprintf("thread:%d", id), title, ns(inst), ns(gran), t)
	}
	rows.Close()
	n, err := im.send(b)
	if err != nil {
		return err
	}
	if err := im.finish("chat_threads", "chat_threads", `SELECT count(*) FROM chat_threads`, n); err != nil {
		return err
	}

	mrows, err := im.src.QueryContext(im.ctx, `SELECT id, thread_id, role, content, context, created_at FROM chat_messages`)
	if err != nil {
		return err
	}
	defer mrows.Close()
	mb := &pgx.Batch{}
	for mrows.Next() {
		var id, tid int64
		var role, content, created string
		var c sql.NullString
		if err := mrows.Scan(&id, &tid, &role, &content, &c, &created); err != nil {
			return err
		}
		t, err := parseTime(created)
		if err != nil {
			return err
		}
		// A message whose thread was deleted has no parent: the insert selects nothing.
		mb.Queue(`INSERT INTO chat_messages (source_key,thread_key,role,content,context,created_at)
			SELECT $1,$2,$3,$4,$5,$6 WHERE EXISTS (SELECT 1 FROM chat_threads WHERE source_key=$2) ON CONFLICT DO NOTHING`,
			fmt.Sprintf("message:%d", id), fmt.Sprintf("thread:%d", tid), role, content, nullJSON(c), t)
	}
	if err := mrows.Err(); err != nil {
		return err
	}
	mn, err := im.send(mb)
	if err != nil {
		return err
	}
	return im.finish("chat_messages", "chat_messages", `SELECT count(*) FROM chat_messages WHERE thread_id IN (SELECT id FROM chat_threads)`, mn)
}

func (im *importer) rules() error {
	rows, err := im.src.QueryContext(im.ctx, `SELECT id, content, weight, source, archived, created_at, updated_at FROM memories`)
	if err != nil {
		return err
	}
	defer rows.Close()
	b := &pgx.Batch{}
	for rows.Next() {
		var id int64
		var content, source, created, updated string
		var weight, archived int
		if err := rows.Scan(&id, &content, &weight, &source, &archived, &created, &updated); err != nil {
			return err
		}
		ct, err := parseTime(created)
		if err != nil {
			return err
		}
		ut, err := parseTime(updated)
		if err != nil {
			return err
		}
		b.Queue(`INSERT INTO standing_rules (source_key,content,weight,source,archived,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
			fmt.Sprintf("memory:%d", id), content, weight, source, archived != 0, ct, ut)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	n, err := im.send(b)
	if err != nil {
		return err
	}
	return im.finish("standing_rules", "standing_rules", `SELECT count(*) FROM memories`, n)
}

func (im *importer) prompts() error {
	rows, err := im.src.QueryContext(im.ctx, `SELECT gate, version, prompt, created_by, created_at, active FROM gate_prompts`)
	if err != nil {
		return err
	}
	defer rows.Close()
	b := &pgx.Batch{}
	for rows.Next() {
		var gate, prompt, by, created string
		var version, active int
		if err := rows.Scan(&gate, &version, &prompt, &by, &created, &active); err != nil {
			return err
		}
		t, err := parseTime(created)
		if err != nil {
			return err
		}
		b.Queue(`INSERT INTO prompt_versions (gate,version,prompt,created_by,created_at,active) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
			gate, version, prompt, by, t, active != 0)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	n, err := im.send(b)
	if err != nil {
		return err
	}
	return im.finish("prompt_versions", "prompt_versions", `SELECT count(*) FROM gate_prompts`, n)
}

func (im *importer) rechecks() error {
	rows, err := im.src.QueryContext(im.ctx, `SELECT id, instrument, granularity, signal_time, at, verdict, reason, prompt_version FROM signal_rechecks`)
	if err != nil {
		return err
	}
	defer rows.Close()
	b := &pgx.Batch{}
	for rows.Next() {
		var id int64
		var inst, gran, st, at, verdict string
		var reason, pv sql.NullString
		if err := rows.Scan(&id, &inst, &gran, &st, &at, &verdict, &reason, &pv); err != nil {
			return err
		}
		sig, err := parseTime(st)
		if err != nil {
			return err
		}
		t, err := parseTime(at)
		if err != nil {
			return err
		}
		b.Queue(`INSERT INTO rechecks (source_key,instrument,granularity,signal_time,at,verdict,reason,prompt_version) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
			fmt.Sprintf("recheck:%d", id), inst, gran, sig, t, verdict, ns(reason), ns(pv))
	}
	if err := rows.Err(); err != nil {
		return err
	}
	n, err := im.send(b)
	if err != nil {
		return err
	}
	return im.finish("rechecks", "rechecks", `SELECT count(*) FROM signal_rechecks`, n)
}

// send runs a batch and returns how many rows were newly inserted.
func (im *importer) send(b *pgx.Batch) (int, error) {
	if b.Len() == 0 {
		return 0, nil
	}
	total := 0
	// keep each round trip bounded
	res := im.tx.SendBatch(im.ctx, b)
	defer res.Close()
	for i := 0; i < b.Len(); i++ {
		tag, err := res.Exec()
		if err != nil {
			return 0, err
		}
		total += int(tag.RowsAffected())
	}
	return total, nil
}

func (im *importer) instrumentsAndAgents(o Options) error {
	// instruments: the validated symbol list plus anything the data mentions
	names := map[string][2]string{}
	if b, err := os.ReadFile(o.SymbolsPath); err == nil {
		var f struct {
			Markets map[string][]struct {
				Symbol string `json:"symbol"`
				Name   string `json:"name"`
			} `json:"markets"`
		}
		if json.Unmarshal(b, &f) == nil {
			// sorted, so a symbol listed in two markets always lands in the same one
			for _, market := range slices.Sorted(maps.Keys(f.Markets)) {
				list := f.Markets[market]
				for _, s := range list {
					names[s.Symbol] = [2]string{s.Name, market}
				}
			}
		}
	} else {
		im.rep.Notes = append(im.rep.Notes, "symbols file unreadable: "+err.Error())
	}
	rows, err := im.tx.Query(im.ctx, `SELECT DISTINCT instrument FROM candles UNION SELECT DISTINCT instrument FROM signals UNION SELECT DISTINCT instrument FROM trades ORDER BY 1`)
	if err != nil {
		return err
	}
	var seen []string
	for rows.Next() {
		var s string
		if err := rows.Scan(&s); err != nil {
			rows.Close()
			return err
		}
		seen = append(seen, s)
	}
	rows.Close()
	all := map[string]bool{}
	for s := range names {
		all[s] = true
	}
	for _, s := range seen {
		if !all[s] {
			im.rep.Notes = append(im.rep.Notes, "instrument "+s+" is in the data but not in the symbols file")
		}
		all[s] = true
	}
	for _, s := range slices.Sorted(maps.Keys(all)) {
		n, ok := names[s]
		if !ok {
			n = [2]string{s, "unknown"}
		}
		if _, err := im.tx.Exec(im.ctx, `INSERT INTO instruments (symbol,name,market) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, s, n[0], n[1]); err != nil {
			return err
		}
		im.rep.Instruments = append(im.rep.Instruments, s)
	}
	sort.Strings(im.rep.Instruments)

	// agents: one LLM agent per legacy bot. It stays off until the operator turns
	// it on, so an import never spends money. A manual entry check still runs it.
	sb, err := os.ReadFile(o.SettingsPath)
	if err != nil {
		im.rep.Notes = append(im.rep.Notes, "settings unreadable, no agents created: "+err.Error())
		return nil
	}
	var st struct {
		Bot struct {
			Bots map[string]struct {
				Enabled      *bool   `json:"enabled"`
				StrategyName *string `json:"strategyName"`
			} `json:"bots"`
		} `json:"bot"`
	}
	if err := json.Unmarshal(sb, &st); err != nil {
		return fmt.Errorf("settings: %w", err)
	}
	keys := make([]string, 0, len(st.Bot.Bots))
	for k := range st.Bot.Bots {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	tools := []string{"get_snapshot", "get_portfolio", "get_recent_candles", "get_recent_signals", "schedule_followup"}
	for _, k := range keys {
		bot := st.Bot.Bots[k]
		parts := strings.Split(k, "|")
		if len(parts) != 2 {
			im.rep.Notes = append(im.rep.Notes, "skipped malformed bot key "+k)
			continue
		}
		inst, gran := parts[0], parts[1]
		enabled := bot.Enabled != nil && *bot.Enabled
		strat := ""
		if bot.StrategyName != nil {
			strat = *bot.StrategyName
		}
		base := "legacy-" + strings.NewReplacer("/", "-").Replace(strings.ToLower(inst)) + "-" + strings.ToLower(gran)
		_ = enabled // the legacy bot's own on/off stays in the engine; the agent starts off
		for _, v := range []struct{ suffix, runtime string }{{"llm", "llm"}} {
			id := base + "-" + v.suffix
			on := false
			tag, err := im.tx.Exec(im.ctx, `INSERT INTO agents (id,name,instrument,granularity,runtime,strategy_name,allowed_tools,enabled,legacy_bot)
				VALUES ($1,$2,$3,$4,$5,NULLIF($6,''),$7,$8,true) ON CONFLICT (id) DO NOTHING`,
				id, fmt.Sprintf("%s %s · %s", inst, gran, v.runtime), inst, gran, v.runtime, strat, tools, on)
			if err != nil {
				return err
			}
			if _, err := im.tx.Exec(im.ctx, `INSERT INTO sessions (agent_id) VALUES ($1) ON CONFLICT (agent_id) DO NOTHING`, id); err != nil {
				return err
			}
			if tag.RowsAffected() > 0 {
				im.rep.Agents = append(im.rep.Agents, id)
			}
		}
	}
	return nil
}

func (im *importer) invariants(o Options) error {
	ctx := im.ctx

	// 1. every table holds at least what the source held
	for _, name := range slices.Sorted(maps.Keys(im.rep.Tables)) {
		t := im.rep.Tables[name]
		im.rep.check("rows:"+name, t.Destination >= t.Source, "source %d, destination %d, newly inserted %d", t.Source, t.Destination, t.Inserted)
	}

	// 1b. a console-authored version with the same name and number would make the
	// insert skip the legacy row; the row counts alone would still pass
	var clashes []string
	srows, err := im.src.QueryContext(ctx, `SELECT name, version, prompt FROM strategies`)
	if err != nil {
		return err
	}
	type sv struct {
		name, prompt string
		version      int
	}
	var svs []sv
	for srows.Next() {
		var s sv
		if err := srows.Scan(&s.name, &s.version, &s.prompt); err != nil {
			srows.Close()
			return err
		}
		svs = append(svs, s)
	}
	srows.Close()
	for _, s := range svs {
		var same bool
		if err := im.tx.QueryRow(ctx, `SELECT COALESCE(bool_or(prompt=$3), false) FROM strategies WHERE name=$1 AND version=$2`, s.name, s.version, s.prompt).Scan(&same); err != nil {
			return err
		}
		if !same {
			clashes = append(clashes, fmt.Sprintf("%s v%d", s.name, s.version))
		}
	}
	im.rep.check("legacy strategy versions kept intact", len(clashes) == 0, "%d clash with a different console version %v", len(clashes), clashes)

	// 2. candles match per instrument and granularity
	src := map[string]int{}
	rows, err := im.src.QueryContext(ctx, `SELECT instrument||'|'||granularity, count(*) FROM candles GROUP BY 1`)
	if err != nil {
		return err
	}
	for rows.Next() {
		var k string
		var n int
		if err := rows.Scan(&k, &n); err != nil {
			rows.Close()
			return err
		}
		src[k] = n
	}
	rows.Close()
	dst := map[string]int{}
	drows, err := im.tx.Query(ctx, `SELECT instrument||'|'||granularity, count(*) FROM candles GROUP BY 1`)
	if err != nil {
		return err
	}
	for drows.Next() {
		var k string
		var n int
		if err := drows.Scan(&k, &n); err != nil {
			drows.Close()
			return err
		}
		dst[k] = n
	}
	drows.Close()
	var short []string
	for k, n := range src {
		if dst[k] < n {
			short = append(short, fmt.Sprintf("%s src %d dst %d", k, n, dst[k]))
		}
	}
	sort.Strings(short)
	im.rep.check("candles per instrument and granularity", len(short) == 0, "%d groups checked, %d short %v", len(src), len(short), short)

	// 3. account: cash minus the starting balance equals realized profit while no position is open
	// The import must not commit unless cash reconciles, so every case where it
	// cannot be checked is a failed check, never a skip.
	const cashCheck = "cash reconciles with realized profit"
	var start, cash float64
	err = im.tx.QueryRow(ctx, `SELECT starting_balance, cash FROM portfolio_account WHERE id=1`).Scan(&start, &cash)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		im.rep.check(cashCheck, false, "no portfolio account row to reconcile")
	case err != nil:
		return err
	default:
		var realized float64
		if err := im.tx.QueryRow(ctx, `SELECT COALESCE(sum(realized),0) FROM trades`).Scan(&realized); err != nil {
			return err
		}
		open, err := im.srcCount(`SELECT count(*) FROM positions`)
		if err != nil {
			return err
		}
		if open == 0 {
			im.rep.check(cashCheck, math.Abs((cash-start)-realized) < 0.01,
				"cash %.4f - start %.4f = %.4f, sum of trades %.4f", cash, start, cash-start, realized)
		} else {
			im.rep.check(cashCheck, false, "%d open positions in the source: cash cannot reconcile, close them before importing", open)
		}
	}

	// 4. each trade has its open entry in the journal
	var orphan int
	if err := im.tx.QueryRow(ctx, `SELECT count(*) FROM trades t WHERE NOT EXISTS (SELECT 1 FROM bot_journal j WHERE j.action='open' AND j.position_id=t.position_id)`).Scan(&orphan); err != nil {
		return err
	}
	im.rep.check("every trade has a journal open entry", orphan == 0, "%d trades without one", orphan)

	// 5. each configured bot points at a strategy that exists and is active
	var missing []string
	arows, err := im.tx.Query(ctx, `SELECT DISTINCT strategy_name FROM agents WHERE legacy_bot AND strategy_name IS NOT NULL`)
	if err != nil {
		return err
	}
	var names []string
	for arows.Next() {
		var n string
		if err := arows.Scan(&n); err != nil {
			arows.Close()
			return err
		}
		names = append(names, n)
	}
	arows.Close()
	for _, n := range names {
		var ok bool
		if err := im.tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM strategies WHERE name=$1 AND active AND NOT archived)`, n).Scan(&ok); err != nil {
			return err
		}
		if !ok {
			missing = append(missing, n)
		}
	}
	im.rep.check("every bot strategy exists and is active", len(missing) == 0, "%d checked, missing %v", len(names), missing)
	return nil
}

func ns(s sql.NullString) any {
	if s.Valid {
		return s.String
	}
	return nil
}

func nf(f sql.NullFloat64) any {
	if f.Valid {
		return f.Float64
	}
	return nil
}
