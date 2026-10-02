package api

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"strings"
	"testing"
)

func TestTriageNewsTranslatesMarksAndFailsOpen(t *testing.T) {
	calls := 0
	s := &Server{log: slog.New(slog.NewTextHandler(io.Discard, nil)), tri: &newsTriage{seen: map[string]triage{}}}
	s.cfg.Complete = func(_ context.Context, msgs []map[string]any) (string, error) {
		calls++
		if !strings.Contains(msgs[1]["content"].(string), "WTICO/USD") {
			t.Fatalf("prompt lacks the instrument: %v", msgs[1]["content"])
		}
		return "Here: [{\"i\":0,\"en\":\"Egg patties: one trick keeps them fluffy\",\"relevant\":false},{\"i\":1,\"en\":\"Oil rises on supply fears\",\"relevant\":true}]", nil
	}
	raw := json.RawMessage(`{"ok":true,"items":[{"title":"Eierfrikadellen: Mit einem Kniff"},{"title":"Oil rises on supply fears"}]}`)

	var got struct {
		Hidden int `json:"hidden"`
		Items  []struct {
			Title, TitleOriginal string
			Relevant             *bool
		} `json:"items"`
	}
	if err := json.Unmarshal(s.triageNews(context.Background(), "WTICO/USD", "WTI Crude", raw), &got); err != nil {
		t.Fatal(err)
	}
	if got.Hidden != 1 || got.Items[0].Title != "Egg patties: one trick keeps them fluffy" || got.Items[0].TitleOriginal != "Eierfrikadellen: Mit einem Kniff" || *got.Items[0].Relevant {
		t.Fatalf("first item not translated and hidden: %+v", got)
	}
	if !*got.Items[1].Relevant || got.Items[1].TitleOriginal != "" {
		t.Fatalf("English relevant item changed: %+v", got.Items[1])
	}

	s.triageNews(context.Background(), "WTICO/USD", "WTI Crude", raw)
	if calls != 1 {
		t.Fatalf("cached headlines called the model again: %d calls", calls)
	}

	s.tri.seen = map[string]triage{}
	s.cfg.Complete = func(context.Context, []map[string]any) (string, error) { return "", errors.New("down") }
	if out := s.triageNews(context.Background(), "WTICO/USD", "WTI Crude", raw); strings.Contains(string(out), `"relevant"`) {
		t.Fatalf("a failed model call must leave items unmarked: %s", out)
	}
}
