package db

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
)

// stackLockKey is the session advisory lock one control plane holds per database. Advisory locks are local to
// one database, so a development and a live control plane on two databases of one server do not block each other.
const stackLockKey = 727002

// HoldStackLock takes the control-plane lock for the database at url on a dedicated connection named appName.
// It returns that connection, which must stay open for the process lifetime: Postgres releases the lock when
// the session ends, also when the process is killed. When another session holds the lock, the error names the
// database and the holder.
func HoldStackLock(ctx context.Context, url, appName string) (*pgx.Conn, error) {
	cfg, err := pgx.ParseConfig(url)
	if err != nil {
		return nil, err
	}
	cfg.RuntimeParams["application_name"] = appName
	conn, err := pgx.ConnectConfig(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("postgres unreachable: %w", err)
	}
	var got bool
	if err := conn.QueryRow(ctx, `SELECT pg_try_advisory_lock($1)`, int64(stackLockKey)).Scan(&got); err != nil {
		conn.Close(context.Background())
		return nil, err
	}
	if got {
		return conn, nil
	}
	defer conn.Close(context.Background())
	var (
		dbname, holder string
		pid            *int32
		since          *time.Time
	)
	// a bigint advisory key shows in pg_locks as classid (high 32 bits), objid (low 32 bits) and objsubid 1
	err = conn.QueryRow(ctx, `SELECT current_database(), a.pid, coalesce(a.application_name, ''), a.backend_start
		FROM pg_locks l LEFT JOIN pg_stat_activity a ON a.pid = l.pid
		WHERE l.locktype = 'advisory' AND l.granted AND l.objsubid = 1 AND l.classid = 0 AND l.objid = $1
		  AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())`, int64(stackLockKey)).
		Scan(&dbname, &pid, &holder, &since)
	if err != nil {
		// the holder ended between the two queries; a restart takes the lock
		return nil, fmt.Errorf("database %s: another control plane held the lock and has just released it; start again: %w", cfg.Database, err)
	}
	return nil, fmt.Errorf("database %s is held by another control plane: backend pid %s, application_name %q, started %s",
		dbname, fmtPid(pid), holder, fmtTime(since))
}

func fmtPid(p *int32) string {
	if p == nil {
		return "unknown"
	}
	return fmt.Sprint(*p)
}

func fmtTime(t *time.Time) string {
	if t == nil {
		return "unknown"
	}
	return t.Format(time.RFC3339)
}
