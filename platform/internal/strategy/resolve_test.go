package strategy

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"testing"

	"github.com/mfittko/market-signals/platform/internal/golden"
	"github.com/mfittko/market-signals/platform/internal/testutil"
)

type resolveInput struct {
	Instrument  string         `json:"instrument"`
	Granularity string         `json:"granularity"`
	Settings    map[string]any `json:"settings"`
	Rows        [][]any        `json:"rows"` // name, version, active, archived
}

type row struct {
	id               int64
	name             string
	version          int
	active, archived bool
}

func (in resolveInput) rows() []row {
	out := make([]row, len(in.Rows))
	for i, r := range in.Rows {
		out[i] = row{int64(i + 1), r[0].(string), int(r[1].(float64)), r[2] == 1.0, r[3] == 1.0}
	}
	return out
}

// memLookup answers like the engine's SQLite reads: the first active row in id order.
type memLookup []row

func (m memLookup) ActiveName(context.Context) (string, bool, error) {
	for _, r := range m {
		if r.active {
			return r.name, true, nil
		}
	}
	return "", false, nil
}

func (m memLookup) NameByEngineID(_ context.Context, id int64) (string, bool, error) {
	for _, r := range m {
		if r.id == id {
			return r.name, true, nil
		}
	}
	return "", false, nil
}

func (m memLookup) ActiveByName(_ context.Context, name string) (Active, bool, error) {
	for _, r := range m {
		if r.active && r.name == name {
			return Active{r.name, r.version, ""}, true, nil
		}
	}
	return Active{}, false, nil
}

func replayResolve(t *testing.T, lookup func(*testing.T, []row) Lookup) {
	data, err := os.ReadFile("../../../test/golden/strategies.json")
	if err != nil {
		t.Fatal(err)
	}
	f, err := golden.Decode(data, "strategies")
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	for _, c := range f.Cases {
		var in resolveInput
		if err := json.Unmarshal(c.Input, &in); err != nil {
			t.Fatal(c.Name, err)
		}
		lk := lookup(t, in.rows())
		b, err := ResolveBotFor(ctx, in.Settings, in.Instrument, in.Granularity, lk)
		if err != nil {
			t.Fatal(c.Name, err)
		}
		got := map[string]any{"botFor": b, "resolved": nil}
		if !b.Configured {
			got["botFor"] = map[string]any{"enabled": false, "configured": false}
		}
		if a, ok, err := ResolvedStrategy(ctx, lk, b); err != nil {
			t.Fatal(c.Name, err)
		} else if ok {
			got["resolved"] = map[string]any{"name": a.Name, "version": a.Version}
		}
		if err := golden.Match(got, c.Expected); err != nil {
			t.Errorf("%s: %v", c.Name, err)
		}
	}
}

func TestResolveDropsAStrategyIdBeyond2To53(t *testing.T) {
	for n, want := range map[float64]bool{1 << 53: true, -(1 << 53): true, 1<<53 + 2: false, 1e300: false} {
		settings := map[string]any{"bot": map[string]any{"bots": map[string]any{"X|M5": map[string]any{"strategyId": n}}}}
		b, err := ResolveBotFor(context.Background(), settings, "X", "M5", memLookup(nil))
		if err != nil || (b.StrategyID != nil) != want {
			t.Fatalf("strategyId %g: %v %v", n, b.StrategyID, err)
		}
	}
}

func TestGoldenResolve(t *testing.T) {
	replayResolve(t, func(_ *testing.T, rows []row) Lookup { return memLookup(rows) })
}

// TestGoldenResolvePostgres replays the same cases through the Postgres Lookup.
func TestGoldenResolvePostgres(t *testing.T) {
	pool := testutil.Pool(t)
	ctx := context.Background()
	replayResolve(t, func(t *testing.T, rows []row) Lookup {
		if _, err := pool.Exec(ctx, `TRUNCATE strategies`); err != nil {
			t.Fatal(err)
		}
		for _, r := range rows {
			if _, err := pool.Exec(ctx, `INSERT INTO strategies (engine_id,name,version,prompt,created_by,created_at,active,archived,dedicated)
				VALUES ($1,$2,$3,$4,'engine',now(),$5,$6,false)`, r.id, r.name, r.version, fmt.Sprintf("%s v%d rules", r.name, r.version), r.active, r.archived); err != nil {
				t.Fatal(err)
			}
		}
		return Store{pool}
	})
}
