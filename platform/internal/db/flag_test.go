package db_test

import (
	"bytes"
	"flag"
	"strings"
	"testing"

	"github.com/mfittko/market-signals/platform/internal/db"
)

const (
	dummyPassword = "dummy-secret-pw"
	dummyURL      = "postgres://user:" + dummyPassword + "@localhost:5432/dummy"
)

func newFlagSet() (*flag.FlagSet, *bytes.Buffer, func() string) {
	fs := flag.NewFlagSet("cmd", flag.ContinueOnError)
	var out bytes.Buffer
	fs.SetOutput(&out)
	return fs, &out, db.URLFlag(fs, "postgres URL (default $MS_DATABASE_URL)")
}

func TestURLFlagKeepsURLOutOfUsage(t *testing.T) {
	t.Setenv("MS_DATABASE_URL", dummyURL)
	for _, args := range [][]string{{"-help"}, {"-nope"}} {
		fs, out, _ := newFlagSet()
		if err := fs.Parse(args); err == nil {
			t.Fatalf("%v: want a parse error", args)
		}
		if !strings.Contains(out.String(), "-db") {
			t.Fatalf("%v: usage misses -db: %q", args, out.String())
		}
		if strings.Contains(out.String(), dummyURL) || strings.Contains(out.String(), dummyPassword) {
			t.Fatalf("%v: output leaks the database URL: %q", args, out.String())
		}
	}
}

func TestURLFlagPrecedence(t *testing.T) {
	t.Setenv("MS_DATABASE_URL", dummyURL)
	fs, _, url := newFlagSet()
	if err := fs.Parse([]string{"-db", "postgres://flag"}); err != nil {
		t.Fatal(err)
	}
	if got := url(); got != "postgres://flag" {
		t.Fatalf("-db: got %q", got)
	}
	fs, _, url = newFlagSet()
	if err := fs.Parse(nil); err != nil {
		t.Fatal(err)
	}
	if got := url(); got != dummyURL {
		t.Fatalf("fallback: got %q", got)
	}
}
