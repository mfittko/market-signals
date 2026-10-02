package runtime_test

import "github.com/mfittko/market-signals/platform/internal/domain"

func holdDecision() *domain.Decision { d := domain.Hold("test hold"); return &d }
