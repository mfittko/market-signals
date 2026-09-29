package tools

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

func TestGetCachedReusesAnAnswerUntilItExpiresAndNeverCachesFailures(t *testing.T) {
	var hits atomic.Int32
	fail := atomic.Bool{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		if fail.Load() {
			http.Error(w, "down", 500)
			return
		}
		w.Write([]byte(`{"n":1}`))
	}))
	defer srv.Close()
	e := NewEngine(srv.URL)
	var out struct{ N int }
	get := func(ttl time.Duration) error { return e.GetCached(context.Background(), ttl, "/x", nil, &out) }

	if err := get(time.Minute); err != nil || out.N != 1 {
		t.Fatalf("first call: %v %+v", err, out)
	}
	if err := get(time.Minute); err != nil || hits.Load() != 1 {
		t.Fatalf("a second call inside the ttl must not reach the engine (hits %d, err %v)", hits.Load(), err)
	}
	if err := get(0); err != nil || hits.Load() != 2 {
		t.Fatalf("an expired entry must be fetched again (hits %d)", hits.Load())
	}
	fail.Store(true)
	e2 := NewEngine(srv.URL)
	if err := e2.GetCached(context.Background(), time.Minute, "/y", nil, &out); err == nil {
		t.Fatal("a failing engine must surface the error")
	}
	fail.Store(false)
	if err := e2.GetCached(context.Background(), time.Minute, "/y", nil, &out); err != nil {
		t.Fatalf("a failure must not be cached: %v", err)
	}
}
