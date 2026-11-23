// Command research-e0 runs a frozen research spec on an exported bid and ask candle
// file and writes the artifact JSON. It reads two local files and nothing else.
//
//	go run ./cmd/research-e0 --spec ../docs/research/experiments/e0/spec.json --data <export.csv> --out <artifact.json>
package main

import (
	"bufio"
	"crypto/sha256"
	"encoding/hex"
	"flag"
	"fmt"
	"os"

	"github.com/mfittko/market-signals/platform/internal/research"
)

func main() {
	spec := flag.String("spec", "", "spec JSON path")
	data := flag.String("data", "", "export CSV path")
	out := flag.String("out", "", "artifact JSON path to write")
	flag.Parse()
	if *spec == "" || *data == "" || *out == "" {
		flag.Usage()
		os.Exit(2)
	}
	if err := run(*spec, *data, *out); err != nil {
		fmt.Fprintln(os.Stderr, "research-e0:", err)
		os.Exit(1)
	}
}

func run(specPath, dataPath, outPath string) error {
	specJSON, err := os.ReadFile(specPath)
	if err != nil {
		return err
	}
	f, err := os.Open(dataPath)
	if err != nil {
		return err
	}
	defer f.Close()
	art, err := research.Execute(specJSON, bufio.NewReaderSize(f, 1<<20))
	if err != nil {
		return err
	}
	if err := os.WriteFile(outPath, art, 0o644); err != nil {
		return err
	}
	sum := sha256.Sum256(art)
	fmt.Printf("%s  %s\n", hex.EncodeToString(sum[:]), outPath)
	return nil
}
