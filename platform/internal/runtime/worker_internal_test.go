package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/mfittko/market-signals/platform/internal/queue"
)

type failWith struct{ err error }

func (failWith) Name() string               { return "mock" }
func (failWith) Capabilities() Capabilities { return Mock{}.Capabilities() }
func (f failWith) Run(context.Context, Input) (*Output, error) {
	return nil, f.err
}

// failReport runs one claim whose runtime fails with err against a fake control plane and returns the
// retryable flag of the fail report.
func failReport(t *testing.T, err error) bool {
	t.Helper()
	reports := make(chan bool, 1)
	plane := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v1/runtime/tools":
			w.Write([]byte(`{"tools":[]}`))
		case "/api/v1/runtime/fail":
			var b struct{ Retryable bool }
			_ = json.NewDecoder(r.Body).Decode(&b)
			reports <- b.Retryable
			w.WriteHeader(http.StatusNoContent)
		default:
			w.WriteHeader(http.StatusNoContent)
		}
	}))
	defer plane.Close()
	w := &Worker{ID: "w1", Client: NewClient(plane.URL, "w"), Runtimes: map[string]Runtime{"mock": failWith{err}},
		Heartbeat: time.Hour, RunTimeout: 5 * time.Second, Log: slog.New(slog.DiscardHandler)}
	w.execute(context.Background(), &queue.Claim{Agent: queue.Agent{Runtime: "mock"}})
	select {
	case r := <-reports:
		return r
	default:
		t.Fatal("the worker sent no fail report")
		return false
	}
}

func TestWorkerFailsNonRetryableAtTheCapAndOnUnrecordedSpend(t *testing.T) {
	for _, c := range []struct {
		err       error
		retryable bool
	}{
		{&ModelError{Reason: ReasonCapReached}, false},
		{&ModelError{Reason: ReasonSpendUnrecorded}, false},
		{&ModelError{Reason: ReasonProvider, Status: 502}, true},
		{errors.New("provider unavailable"), true},
	} {
		if got := failReport(t, c.err); got != c.retryable {
			t.Errorf("%v: retryable %v, want %v", c.err, got, c.retryable)
		}
	}
}
