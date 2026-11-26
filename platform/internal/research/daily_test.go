package research

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
	"testing"
)

type fakeRoundTripper struct{ reqs []*http.Request }

func (f *fakeRoundTripper) RoundTrip(r *http.Request) (*http.Response, error) {
	f.reqs = append(f.reqs, r)
	return &http.Response{StatusCode: http.StatusServiceUnavailable, Body: io.NopCloser(strings.NewReader("")), Request: r}, nil
}

func TestFXEmpireDailyRequestRefusalAndCancelledPause(t *testing.T) {
	rt := &fakeRoundTripper{}
	f := &FXEmpire{Client: &http.Client{Transport: rt}}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	if _, err := f.Daily(ctx, "SPX500/USD"); err == nil || err.Error() != "daily SPX500/USD: HTTP 503" {
		t.Fatalf("err = %v, want the HTTP 503 refusal", err)
	}
	if len(rt.reqs) != 1 {
		t.Fatalf("%d requests, want 1", len(rt.reqs))
	}
	r := rt.reqs[0]
	want := url.Values{"instrument": {"SPX500/USD"}, "granularity": {"D"}, "count": {"250"}, "price": {"M"},
		"dailyAlignment": {"17"}, "alignmentTimezone": {"America/New_York"}}
	if r.Method != http.MethodGet || r.URL.Host != "p.fxempire.com" || r.URL.Path != "/oanda/candles/latest" || r.URL.RawQuery != want.Encode() {
		t.Fatalf("request %s %s, want GET with query %s", r.Method, r.URL, want.Encode())
	}
	if r.Header.Get("accept") != "application/json,*/*" || r.Header.Get("user-agent") != "Mozilla/5.0 (market-signals; supertrend)" {
		t.Fatalf("headers %v", r.Header)
	}

	// the second call waits out the pause, so a cancelled context ends it without a request
	cancel()
	if _, err := f.Daily(ctx, "NAS100/USD"); !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v, want context.Canceled", err)
	}
	if len(rt.reqs) != 1 {
		t.Fatalf("%d requests, want no second request", len(rt.reqs))
	}
}
