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

type triagedDoc struct {
	Hidden int `json:"hidden"`
	Items  []struct {
		Title, TitleOriginal string
		Relevant             *bool
		Pending              bool
	} `json:"items"`
}

func triageOnce(t *testing.T, s *Server, raw json.RawMessage) triagedDoc {
	t.Helper()
	var d triagedDoc
	if err := json.Unmarshal(s.triageNews(context.Background(), "WTICO/USD", "WTI Crude", raw), &d); err != nil {
		t.Fatal(err)
	}
	return d
}

func TestTriageNewsAnswersAtOnceThenTranslatesAndHides(t *testing.T) {
	calls := 0
	s := &Server{log: slog.New(slog.NewTextHandler(io.Discard, nil)), tri: newNewsTriage()}
	s.cfg.Complete = func(_ context.Context, msgs []map[string]any) (string, error) {
		calls++
		if !strings.Contains(msgs[1]["content"].(string), "WTICO/USD") {
			t.Fatalf("prompt lacks the instrument: %v", msgs[1]["content"])
		}
		return "Here: [{\"i\":0,\"en\":\"Egg patties: one trick keeps them fluffy\",\"relevant\":false},{\"i\":1,\"en\":\"Oil rises on supply fears\",\"relevant\":true}]", nil
	}
	raw := json.RawMessage(`{"ok":true,"items":[{"title":"Eierfrikadellen: Mit einem Kniff"},{"title":"Oil rises on supply fears"}]}`)

	first := triageOnce(t, s, raw)
	if !first.Items[0].Pending || !first.Items[1].Pending {
		t.Fatalf("unknown headlines must be pending on the first answer: %+v", first)
	}
	s.tri.wg.Wait()

	got := triageOnce(t, s, raw)
	if got.Hidden != 1 || got.Items[0].Title != "Egg patties: one trick keeps them fluffy" || got.Items[0].TitleOriginal != "Eierfrikadellen: Mit einem Kniff" || *got.Items[0].Relevant || got.Items[0].Pending {
		t.Fatalf("first item not translated and hidden: %+v", got)
	}
	if !*got.Items[1].Relevant || got.Items[1].TitleOriginal != "" {
		t.Fatalf("English relevant item changed: %+v", got.Items[1])
	}
	if calls != 1 {
		t.Fatalf("cached headlines called the model again: %d calls", calls)
	}
}

func TestTriageNewsFailsOpenAndBacksOff(t *testing.T) {
	calls := 0
	s := &Server{log: slog.New(slog.NewTextHandler(io.Discard, nil)), tri: newNewsTriage()}
	s.cfg.Complete = func(context.Context, []map[string]any) (string, error) { calls++; return "", errors.New("down") }
	raw := json.RawMessage(`{"ok":true,"items":[{"title":"Oil rises"}]}`)

	triageOnce(t, s, raw)
	s.tri.wg.Wait()
	got := triageOnce(t, s, raw)
	if got.Items[0].Pending || got.Items[0].Relevant != nil {
		t.Fatalf("after a failed triage the item must show unmarked: %+v", got.Items[0])
	}
	s.tri.wg.Wait()
	if calls != 1 {
		t.Fatalf("a failed triage must pause retries: %d calls", calls)
	}
}

func TestArticleGuardsAndText(t *testing.T) {
	for _, a := range []string{"127.0.0.1:80", "10.1.2.3:443", "192.168.0.5:80", "169.254.169.254:80", "[::1]:443", "0.0.0.0:80"} {
		if publicOnly("tcp", a, nil) == nil {
			t.Fatalf("%s must be refused", a)
		}
	}
	if err := publicOnly("tcp", "93.184.216.34:443", nil); err != nil {
		t.Fatalf("a public address was refused: %v", err)
	}
	if _, err := fetchArticle(context.Background(), "file:///etc/passwd"); err == nil {
		t.Fatal("a non-web URL must be refused")
	}
	got := htmlText(`<html><script>x()</script><nav>menu</nav><p>Oil &amp; gas  rise</p><style>p{}</style></html>`)
	if got != "Oil & gas rise" {
		t.Fatalf("htmlText = %q", got)
	}
}
