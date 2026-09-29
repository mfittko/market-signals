package runtime

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/mfittko/market-signals/platform/internal/domain"
	"github.com/mfittko/market-signals/platform/internal/queue"
	"github.com/mfittko/market-signals/platform/internal/tools"
)

// Capabilities is what a runtime can actually enforce. The control plane will
// not treat a runtime as execution-eligible unless it restricts tools and
// honors cancellation. Checkpoint/resume is reported honestly as unsupported:
// interruptions are recorded and a bounded replacement attempt starts fresh.
type Capabilities struct {
	ContractVersion   string `json:"contractVersion"`
	RestrictedTools   bool   `json:"restrictedTools"`
	Cancellation      bool   `json:"cancellation"`
	Streaming         bool   `json:"streaming"`
	Checkpoint        bool   `json:"checkpoint"`
	ExecutionEligible bool   `json:"executionEligible"`
}

func caps(restricted, cancel, stream bool) Capabilities {
	return Capabilities{ContractVersion: ContractVersion, RestrictedTools: restricted, Cancellation: cancel, Streaming: stream,
		ExecutionEligible: restricted && cancel}
}

// ToolCaller is the only way a runtime reaches the outside world.
type ToolCaller interface {
	Defs() []tools.Def
	Call(ctx context.Context, name string, args json.RawMessage) (output string, isError bool, err error)
}

type Input struct {
	Claim *queue.Claim
	Tools ToolCaller
	Emit  func(kind string, payload any)
}

type Output struct {
	Proposal   *domain.Decision
	Usage      map[string]float64
	StopReason string
}

// Runtime is the adapter contract. Run must stop promptly when ctx is done.
type Runtime interface {
	Name() string
	Capabilities() Capabilities
	Run(ctx context.Context, in Input) (*Output, error)
}

var ErrNoProposal = errors.New("runtime produced no proposal")
