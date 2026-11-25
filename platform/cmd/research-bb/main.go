// Command research-bb runs the Bollinger band study on every instrument of the BB spec
// that has an export, and writes the artifact JSON and the markdown report. It reads the
// BB spec, the E0 spec it references and the exports the BB spec names, and nothing
// else. Spec paths are relative to the repository root: the nearest ancestor of the spec
// file that holds platform/go.mod.
//
//	go run ./cmd/research-bb --spec ../docs/research/experiments/bb/spec.json --artifact <artifact.json> --report <report.md>
package main

import (
	"bufio"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"

	"github.com/mfittko/market-signals/platform/internal/research"
)

func main() {
	spec := flag.String("spec", "", "BB spec JSON path")
	artifact := flag.String("artifact", "", "artifact JSON path to write")
	report := flag.String("report", "", "report markdown path to write")
	flag.Parse()
	if *spec == "" || *artifact == "" || *report == "" {
		flag.Usage()
		os.Exit(2)
	}
	if err := run(*spec, *artifact, *report, os.Stderr); err != nil {
		fmt.Fprintln(os.Stderr, "research-bb:", err)
		os.Exit(1)
	}
}

// repoRoot finds the repository root above the spec, so the result does not depend on
// the working directory.
func repoRoot(specPath string) (string, error) {
	resolved, err := filepath.EvalSymlinks(specPath)
	if err != nil {
		return "", err
	}
	dir, err := filepath.Abs(filepath.Dir(resolved))
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

// inRoot joins a spec input path to the root and refuses one that leaves the root.
func inRoot(root, field, p string) (string, error) {
	if !filepath.IsLocal(p) {
		return "", fmt.Errorf("spec field %s: %q is not a relative path inside the repository; fix the spec in a reviewed commit", field, p)
	}
	return filepath.Join(root, p), nil
}

// writeAtomic writes b to a temporary file beside path and renames it over path, so an
// interrupted or failed write leaves the previous file at path unchanged.
func writeAtomic(path string, b []byte) error {
	f, err := os.CreateTemp(filepath.Dir(path), "."+filepath.Base(path)+".tmp-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name()) // fails harmlessly after the rename
	if _, err := f.Write(b); err != nil {
		f.Close()
		return err
	}
	if err := f.Chmod(0o644); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	return os.Rename(f.Name(), path)
}

// run writes the artifact and then the report; it warns on stderr about each instrument
// whose spec pins a dataset sha256 but whose export file is missing.
func run(specPath, artifactPath, reportPath string, stderr io.Writer) error {
	specJSON, err := os.ReadFile(specPath)
	if err != nil {
		return err
	}
	s, err := research.ParseBBSpec(specJSON)
	if err != nil {
		return err
	}
	root, err := repoRoot(specPath)
	if err != nil {
		return err
	}
	e0Path, err := inRoot(root, "e0Spec.path", s.E0Spec.Path)
	if err != nil {
		return err
	}
	inputs := []string{specPath, e0Path}
	for _, inst := range s.Instruments {
		p, err := inRoot(root, inst.Instrument+" dataset.path", inst.Dataset.Path)
		if err != nil {
			return err
		}
		inputs = append(inputs, p)
		if _, err := os.Stat(p); inst.Dataset.SHA256 != nil && errors.Is(err, fs.ErrNotExist) {
			fmt.Fprintf(stderr, "research-bb: warning: %s pins dataset sha256 %s, but %s does not exist; the report lists %s as not run\n", inst.Instrument, *inst.Dataset.SHA256, p, inst.Instrument)
		}
	}
	// the writes replace --artifact and --report, so neither may be an input or the other
	absArtifact, err := filepath.Abs(artifactPath)
	if err != nil {
		return err
	}
	absReport, err := filepath.Abs(reportPath)
	if err != nil {
		return err
	}
	if absArtifact == absReport {
		return fmt.Errorf("--artifact and --report are the same path %s; choose two paths", absReport)
	}
	if a, err := os.Stat(artifactPath); err == nil {
		if r, err := os.Stat(reportPath); err == nil && os.SameFile(a, r) {
			return fmt.Errorf("--artifact %s and --report %s are the same file; choose two paths", artifactPath, reportPath)
		}
	}
	for _, out := range []string{artifactPath, reportPath} {
		if o, err := os.Stat(out); err == nil {
			for _, in := range inputs {
				if i, err := os.Stat(in); err == nil && os.SameFile(o, i) {
					return fmt.Errorf("output %s is the input %s; choose another path", out, in)
				}
			}
		}
	}
	e0JSON, err := os.ReadFile(e0Path)
	if err != nil {
		return err
	}
	report, artifact, err := research.RunBB(research.BBInputs{
		BBJSON: specJSON, E0JSON: e0JSON,
		Open: func(p string) (io.ReadCloser, error) {
			f, err := os.Open(filepath.Join(root, p))
			if err != nil {
				return nil, err
			}
			return struct {
				io.Reader
				io.Closer
			}{bufio.NewReaderSize(f, 1<<20), f}, nil
		},
		Platform: runtime.Version() + " " + runtime.GOOS + "/" + runtime.GOARCH,
	})
	if err != nil {
		return err
	}
	for _, w := range []struct {
		path string
		b    []byte
	}{{artifactPath, artifact}, {reportPath, report}} {
		if err := writeAtomic(w.path, w.b); err != nil {
			return err
		}
		sum := sha256.Sum256(w.b)
		fmt.Printf("%s  %s\n", hex.EncodeToString(sum[:]), w.path)
	}
	return nil
}
