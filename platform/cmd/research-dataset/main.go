// Command research-dataset writes and checks the manifest of an owner export. It reads
// local files and nothing else.
//
//	research-dataset describe <csv> --instrument <I> --granularity M1
//	research-dataset verify <manifest>
//
// describe prints the computed manifest fields as a draft. verify recomputes them from the
// manifest's path, which is relative to the repository root above the manifest, prints
// each difference and exits 1 on any.
package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"

	"github.com/mfittko/market-signals/platform/internal/research"
)

const usage = "usage: research-dataset describe <csv> --instrument <I> --granularity M1 | verify <manifest>"

func main() {
	ok, err := run(os.Args[1:])
	if err != nil {
		fmt.Fprintln(os.Stderr, "research-dataset:", err)
		os.Exit(2)
	}
	if !ok {
		os.Exit(1)
	}
}

func run(args []string) (bool, error) {
	if len(args) < 2 {
		return false, errors.New(usage)
	}
	switch args[0] {
	case "describe":
		fs := flag.NewFlagSet("describe", flag.ContinueOnError)
		inst := fs.String("instrument", "", "instrument, e.g. WTICO/USD")
		gran := fs.String("granularity", "", "granularity; only M1")
		if err := fs.Parse(args[2:]); err != nil {
			return false, err
		}
		if *inst == "" || fs.NArg() != 0 {
			return false, errors.New(usage)
		}
		m, err := describe(args[1], *inst, *gran)
		if err != nil {
			return false, err
		}
		b, err := json.MarshalIndent(m, "", "  ")
		if err != nil {
			return false, err
		}
		fmt.Println(string(b))
		return true, nil
	case "verify":
		if len(args) != 2 {
			return false, errors.New(usage)
		}
		return verify(args[1])
	}
	return false, errors.New(usage)
}

func describe(path, inst, gran string) (research.Manifest, error) {
	f, err := os.Open(path)
	if err != nil {
		return research.Manifest{}, err
	}
	defer f.Close()
	return research.Describe(path, inst, gran, bufio.NewReaderSize(f, 1<<20))
}

func verify(manifestPath string) (bool, error) {
	b, err := os.ReadFile(manifestPath)
	if err != nil {
		return false, err
	}
	var m research.Manifest
	if err := json.Unmarshal(b, &m); err != nil {
		return false, fmt.Errorf("%s: %w", manifestPath, err)
	}
	root, err := repoRoot(manifestPath)
	if err != nil {
		return false, err
	}
	if !filepath.IsLocal(m.Path) {
		return false, fmt.Errorf("%s: path %q is not relative to the repository root", manifestPath, m.Path)
	}
	f, err := os.Open(filepath.Join(root, m.Path))
	if err != nil {
		return false, err
	}
	defer f.Close()
	diffs, err := research.Verify(m, bufio.NewReaderSize(f, 1<<20))
	if err != nil {
		return false, err
	}
	for _, d := range diffs {
		fmt.Println(d)
	}
	if len(diffs) > 0 {
		return false, nil
	}
	fmt.Printf("ok %s: %s %d rows\n", m.Path, m.ID, m.Rows)
	return true, nil
}

// repoRoot finds the nearest ancestor of the manifest that holds platform/go.mod, so verify
// does not depend on the working directory.
func repoRoot(p string) (string, error) {
	dir, err := filepath.Abs(filepath.Dir(p))
	if err != nil {
		return "", err
	}
	for {
		if _, err := os.Stat(filepath.Join(dir, "platform", "go.mod")); err == nil {
			return dir, nil
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return "", fmt.Errorf("no ancestor of %s holds platform/go.mod; keep the manifest inside the repository", p)
		}
		dir = parent
	}
}
