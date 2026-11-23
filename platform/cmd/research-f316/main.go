// Command research-f316 scores the exported live filter verdicts under the E0 rules and
// writes the markdown report. It reads the F316 spec, the E0 spec it references and the
// two exports the specs name, and nothing else. Spec paths are relative to the
// repository root: the nearest ancestor of the spec file that holds platform/go.mod.
//
//	go run ./cmd/research-f316 --spec ../docs/research/experiments/f316/spec.json --out <report.md>
package main

import (
	"bufio"
	"crypto/sha256"
	"encoding/hex"
	"flag"
	"fmt"
	"os"
	"path/filepath"

	"github.com/mfittko/market-signals/platform/internal/research"
)

func main() {
	spec := flag.String("spec", "", "F316 spec JSON path")
	out := flag.String("out", "", "report markdown path to write")
	flag.Parse()
	if *spec == "" || *out == "" {
		flag.Usage()
		os.Exit(2)
	}
	if err := run(*spec, *out); err != nil {
		fmt.Fprintln(os.Stderr, "research-f316:", err)
		os.Exit(1)
	}
}

// repoRoot finds the repository root above the spec, so the result does not depend on
// the working directory.
func repoRoot(specPath string) (string, error) {
	dir, err := filepath.Abs(filepath.Dir(specPath))
	if err != nil {
		return "", err
	}
	for {
		if _, err := os.Stat(filepath.Join(dir, "platform", "go.mod")); err == nil {
			return dir, nil
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return "", fmt.Errorf("no ancestor of %s holds platform/go.mod; keep the spec inside the repository", specPath)
		}
		dir = parent
	}
}

func run(specPath, outPath string) error {
	specJSON, err := os.ReadFile(specPath)
	if err != nil {
		return err
	}
	s, _, err := research.ParseF316Spec(specJSON)
	if err != nil {
		return err
	}
	root, err := repoRoot(specPath)
	if err != nil {
		return err
	}
	e0Path := filepath.Join(root, s.E0Spec.Path)
	e0JSON, err := os.ReadFile(e0Path)
	if err != nil {
		return err
	}
	e0, err := research.ParseSpec(e0JSON)
	if err != nil {
		return err
	}
	dataPath, verdictPath := filepath.Join(root, e0.Dataset.Path), filepath.Join(root, s.Verdicts.Path)
	// the write truncates --out, so --out must not be one of the inputs
	if o, err := os.Stat(outPath); err == nil {
		for _, in := range []string{specPath, e0Path, dataPath, verdictPath} {
			if i, err := os.Stat(in); err == nil && os.SameFile(o, i) {
				return fmt.Errorf("--out %s is the input %s; choose another report path", outPath, in)
			}
		}
	}
	data, err := os.Open(dataPath)
	if err != nil {
		return err
	}
	defer data.Close()
	verdicts, err := os.Open(verdictPath)
	if err != nil {
		return err
	}
	defer verdicts.Close()
	report, err := research.RunF316(research.F316Inputs{
		F316JSON: specJSON, E0JSON: e0JSON,
		Data: bufio.NewReaderSize(data, 1<<20), Verdicts: verdicts,
	})
	if err != nil {
		return err
	}
	if err := os.WriteFile(outPath, report, 0o644); err != nil {
		return err
	}
	sum := sha256.Sum256(report)
	fmt.Printf("%s  %s\n", hex.EncodeToString(sum[:]), outPath)
	return nil
}
