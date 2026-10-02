package api

import (
	"context"
	"errors"
	"fmt"
	"html"
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"syscall"
	"time"
)

// Article fetching for news summaries. The URLs come from public feeds and are untrusted, so the
// client only dials public addresses, caps time and size, and keeps plain text only.

const (
	articleTimeout  = 10 * time.Second
	articleMaxBytes = 1 << 20
	articleMaxText  = 6000
	articleMinText  = 400 // shorter extracts are cookie walls, index pages or redirect stubs
)

var errPrivateAddr = errors.New("refusing a non-public address")

// publicOnly refuses loopback, private, link-local and unspecified addresses at dial time,
// so a redirect or DNS answer cannot point the fetch at the local network.
func publicOnly(_, address string, _ syscall.RawConn) error {
	host, _, err := net.SplitHostPort(address)
	if err != nil {
		return err
	}
	ip := net.ParseIP(host)
	if ip == nil || ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() || ip.IsUnspecified() || ip.IsMulticast() {
		return errPrivateAddr
	}
	return nil
}

var articleClient = &http.Client{
	Timeout: articleTimeout,
	Transport: &http.Transport{
		DialContext:         (&net.Dialer{Timeout: 5 * time.Second, Control: publicOnly}).DialContext,
		TLSHandshakeTimeout: 5 * time.Second,
		MaxIdleConns:        8,
	},
	CheckRedirect: func(req *http.Request, via []*http.Request) error {
		if len(via) >= 5 {
			return errors.New("too many redirects")
		}
		if req.URL.Scheme != "http" && req.URL.Scheme != "https" {
			return errors.New("redirect to a non-web scheme")
		}
		return nil
	},
}

var (
	reDrop  = dropBlocks("script", "style", "noscript", "svg", "nav", "footer", "header", "form")
	reTags  = regexp.MustCompile(`(?s)<[^>]+>`)
	reSpace = regexp.MustCompile(`\s+`)
)

// fetchArticle returns the readable text of a news page, or an error when it has none.
func fetchArticle(ctx context.Context, raw string) (string, error) {
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return "", fmt.Errorf("not a web URL: %q", raw)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 (compatible; market-signals news summary)")
	req.Header.Set("Accept", "text/html,text/plain")
	resp, err := articleClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("article returned %d", resp.StatusCode)
	}
	if ct := resp.Header.Get("Content-Type"); ct != "" && !strings.Contains(ct, "text/html") && !strings.Contains(ct, "text/plain") {
		return "", fmt.Errorf("article is %s", ct)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, articleMaxBytes))
	if err != nil {
		return "", err
	}
	text := htmlText(string(body))
	if len(text) < articleMinText {
		return "", errors.New("no article text")
	}
	if len(text) > articleMaxText {
		text = text[:articleMaxText]
	}
	return text, nil
}

// htmlText strips markup down to plain text.
// ponytail: regex extraction, not a readability parser; swap in one if summaries pick up page chrome.
func htmlText(s string) string {
	for _, re := range reDrop {
		s = re.ReplaceAllString(s, " ")
	}
	s = reTags.ReplaceAllString(s, " ")
	return strings.TrimSpace(reSpace.ReplaceAllString(html.UnescapeString(s), " "))
}

func dropBlocks(tags ...string) []*regexp.Regexp {
	out := make([]*regexp.Regexp, len(tags))
	for i, t := range tags {
		out[i] = regexp.MustCompile(`(?is)<` + t + `\b.*?</` + t + `\s*>`)
	}
	return out
}
