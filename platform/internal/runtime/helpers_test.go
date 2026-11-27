package runtime_test

import (
	"context"
	"sync"

	"github.com/mfittko/market-signals/platform/internal/domain"
	"github.com/mfittko/market-signals/platform/internal/runtime"
)

func holdDecision() *domain.Decision { d := domain.Hold("test hold"); return &d }

// recorder captures the gateway's spend records and the state of the context each one got.
type recorder struct {
	mu      sync.Mutex
	calls   []runtime.SpendCall
	ctxErrs []error
	err     error // returned by every record
}

func (r *recorder) record(ctx context.Context, c runtime.SpendCall) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.calls = append(r.calls, c)
	r.ctxErrs = append(r.ctxErrs, ctx.Err())
	return r.err
}

func (r *recorder) all() []runtime.SpendCall {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]runtime.SpendCall(nil), r.calls...)
}

// shared is the recorder of the tests that do not inspect the spend records.
var shared = &recorder{}
