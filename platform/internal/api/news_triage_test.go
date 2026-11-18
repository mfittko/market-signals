package api

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
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
	for _, a := range []string{"127.0.0.1:80", "10.1.2.3:443", "192.168.0.5:80", "169.254.169.254:80", "[::1]:443", "0.0.0.0:80", "100.64.0.1:443", "100.100.100.100:80", "[64:ff9b::a00:1]:443", "[2002:a00:1::1]:443", "255.255.255.255:80"} {
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

// summaryFixture serves one article page with the given status and answers classification as relevant; the
// summary reply comes from sum. It returns the server, the article link and the summary call count.
func summaryFixture(t *testing.T, status int, page string, sum func() (string, error)) (*Server, string, *int) {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		w.WriteHeader(status)
		_, _ = io.WriteString(w, page)
	}))
	t.Cleanup(srv.Close)
	prev := articleClient
	articleClient = srv.Client() // the real client refuses loopback
	t.Cleanup(func() { articleClient = prev })

	calls := 0
	s := &Server{log: slog.New(slog.NewTextHandler(io.Discard, nil)), tri: newNewsTriage()}
	s.cfg.Complete = func(_ context.Context, msgs []map[string]any) (string, error) {
		if msgs[0]["content"] == summarySystem {
			calls++
			return sum()
		}
		return `[{"i":0,"en":"Oil rises","relevant":true}]`, nil
	}
	return s, srv.URL + "/a", &calls
}

func newsWith(link string) json.RawMessage {
	return json.RawMessage(`{"ok":true,"items":[{"title":"Oil rises","url":"` + link + `"}]}`)
}

var articlePage = "<html><p>" + strings.Repeat("Crude oil rose on supply fears. ", 20) + "</p></html>"

func triageAndWait(t *testing.T, s *Server, raw json.RawMessage) {
	t.Helper()
	triageOnce(t, s, raw)
	s.tri.wg.Wait()
}

func TestSummaryModelErrorIsRetriedAfterBackoff(t *testing.T) {
	s, link, calls := summaryFixture(t, http.StatusOK, articlePage, func() (string, error) { return "", errors.New("down") })
	raw := newsWith(link)
	key := newsKey("WTICO/USD", "Oil rises")

	triageAndWait(t, s, raw) // classifies, then the summary fails
	if *calls != 1 || s.tri.seen[key].Summarized {
		t.Fatalf("a failed summary must stay unfinished: calls=%d record=%+v", *calls, s.tri.seen[key])
	}
	triageAndWait(t, s, raw)
	if *calls != 1 {
		t.Fatalf("a retry within the backoff called the model: %d calls", *calls)
	}
	s.tri.sumFailed[key] = time.Now().Add(-triageBackoff - time.Second)
	triageAndWait(t, s, raw)
	if *calls != 2 || s.tri.seen[key].Summarized {
		t.Fatalf("after the backoff the summary must be retried: calls=%d record=%+v", *calls, s.tri.seen[key])
	}
}

func TestSummaryCancelledContextIsRetryable(t *testing.T) {
	s, link, calls := summaryFixture(t, http.StatusOK, articlePage, func() (string, error) { return "**Oil up.**", nil })
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := s.summarize(ctx, "WTICO/USD", "WTI Crude", "Oil rises", link); !errors.Is(err, context.Canceled) {
		t.Fatalf("a cancelled context must surface as context.Canceled, got %v", err)
	}
	if *calls != 0 {
		t.Fatalf("a cancelled fetch reached the model: %d calls", *calls)
	}
}

func TestSummaryFinishedWithoutArticleOrOnNone(t *testing.T) {
	for name, tc := range map[string]struct {
		status int
		page   string
		reply  string
		calls  int
	}{
		"no article text": {http.StatusOK, "<html><p>Accept cookies</p></html>", "unused", 0},
		"page not found":  {http.StatusNotFound, articlePage, "unused", 0},
		"NONE reply":      {http.StatusOK, articlePage, "NONE", 1},
	} {
		t.Run(name, func(t *testing.T) {
			s, link, calls := summaryFixture(t, tc.status, tc.page, func() (string, error) { return tc.reply, nil })
			raw := newsWith(link)
			key := newsKey("WTICO/USD", "Oil rises")
			triageAndWait(t, s, raw)
			if r := s.tri.seen[key]; !r.Summarized || r.Summary != "" {
				t.Fatalf("the attempt must count as finished with no summary: %+v", r)
			}
			triageAndWait(t, s, raw)
			if *calls != tc.calls {
				t.Fatalf("a finished attempt was retried: %d calls, want %d", *calls, tc.calls)
			}
		})
	}
}
