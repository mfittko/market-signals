package research

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"slices"
	"time"
)

// LabelVersion names the outcome label rule: win when net R is above 0, loss otherwise,
// ambiguous for an end exit, because the data ended before the trade closed.
const LabelVersion = "net-r-sign-v1"

// Attempt is one forecast attempt. A forecast carries Dir; every other status carries Reason.
type Attempt struct {
	ID         string    `json:"id"`
	Mode       string    `json:"mode"` // retrospective | prospective
	Experiment string    `json:"experiment"`
	DataSHA256 string    `json:"dataSha256"`
	SpecSHA256 string    `json:"specSha256"` // the frozen spec carries the strategy and every declared value
	Decision   time.Time `json:"decision"`
	Status     string    `json:"status"` // forecast | hold | timeout | error
	Dir        int       `json:"dir,omitempty"`
	Reason     string    `json:"reason,omitempty"`
	Expiry     time.Time `json:"expiry"`
}

type Outcome struct {
	Attempt      string    `json:"attempt"`
	LabelVersion string    `json:"labelVersion"`
	Matured      time.Time `json:"matured"`
	NetR         float64   `json:"netR"`
	Label        string    `json:"label"` // win | loss | ambiguous
}

type Journal struct {
	Attempts []Attempt
	Outcomes []Outcome
}

// Label applies LabelVersion to a trade.
func Label(t Trade) string {
	switch {
	case t.Reason == "end":
		return "ambiguous"
	case t.NetR > 0:
		return "win"
	}
	return "loss"
}

// Reconstruct turns an artifact into retrospective attempts, one per flip in decision
// order, and one outcome per trade.
func Reconstruct(s Spec, art Artifact) ([]Attempt, []Outcome) {
	expiry := time.Duration(s.Experiment.Strategy.MaxBars*s.Feed.BarSeconds) * time.Second
	at := func(flip, decision time.Time) Attempt {
		return Attempt{ID: art.Experiment + "/" + flip.Format(time.RFC3339Nano), Mode: "retrospective",
			Experiment: art.Experiment, DataSHA256: art.DataSHA256, SpecSHA256: art.SpecSHA256,
			Decision: decision, Expiry: decision.Add(expiry)}
	}
	var attempts []Attempt
	var outcomes []Outcome
	for _, t := range art.Trades {
		a := at(t.Flip, t.Decision)
		a.Status, a.Dir = "forecast", t.Dir
		attempts = append(attempts, a)
		outcomes = append(outcomes, Outcome{Attempt: a.ID, LabelVersion: LabelVersion, Matured: t.Exit, NetR: t.NetR, Label: Label(t)})
	}
	for _, h := range art.Holds {
		a := at(h.Flip, h.Decision)
		a.Status, a.Reason = "hold", h.Reason
		attempts = append(attempts, a)
	}
	slices.SortFunc(attempts, func(a, b Attempt) int { return a.Decision.Compare(b.Decision) })
	return attempts, outcomes
}

func checkAttempt(a Attempt) error {
	switch {
	case a.Mode != "retrospective" && a.Mode != "prospective":
		return fmt.Errorf("attempt %s: mode %q is not retrospective or prospective", a.ID, a.Mode)
	case !slices.Contains([]string{"forecast", "hold", "timeout", "error"}, a.Status):
		return fmt.Errorf("attempt %s: status %q is not forecast, hold, timeout or error", a.ID, a.Status)
	case a.Status == "forecast" && a.Dir != 1 && a.Dir != -1:
		return fmt.Errorf("attempt %s: a forecast needs a direction of 1 or -1", a.ID)
	case a.Status != "forecast" && a.Reason == "":
		return fmt.Errorf("attempt %s: a %s needs a reason", a.ID, a.Status)
	}
	return nil
}

// A journal line is a record with its kind; the embedded fields flatten into one object.
type attemptLine struct {
	Kind string `json:"kind"`
	Attempt
}

type outcomeLine struct {
	Kind string `json:"kind"`
	Outcome
}

const recovery = "build a new journal from the same spec and data at a new path"

// ReadJournal refuses an unparsable line and names its line number.
func ReadJournal(r io.Reader) (Journal, error) {
	var j Journal
	sc := bufio.NewScanner(r)
	sc.Buffer(nil, 1<<20)
	for line := 1; sc.Scan(); line++ {
		var kind struct {
			Kind string `json:"kind"`
		}
		err := json.Unmarshal(sc.Bytes(), &kind)
		d := json.NewDecoder(bytes.NewReader(sc.Bytes()))
		d.DisallowUnknownFields()
		switch {
		case err != nil:
		case kind.Kind == "attempt":
			var a attemptLine
			if err = d.Decode(&a); err == nil {
				err = checkAttempt(a.Attempt)
				j.Attempts = append(j.Attempts, a.Attempt)
			}
		case kind.Kind == "outcome":
			var o outcomeLine
			err = d.Decode(&o)
			j.Outcomes = append(j.Outcomes, o.Outcome)
		default:
			err = fmt.Errorf("kind %q is not attempt or outcome", kind.Kind)
		}
		if err != nil {
			return j, fmt.Errorf("journal line %d: %w; the line is torn or edited, so %s", line, err, recovery)
		}
	}
	return j, sc.Err()
}

// Append adds the records as one line each, in one write call. It refuses the whole batch,
// and leaves the file unchanged, when the last line has no line end, an attempt id is
// already in the journal or an outcome's attempt is missing or already has an outcome. It
// never rewrites a line. A failed write can leave a torn last line, which a later read or
// append refuses, so the recovery is to build a new journal at a new path.
func Append(path string, attempts []Attempt, outcomes []Outcome) error {
	var j Journal
	if b, err := os.ReadFile(path); err == nil {
		if j, err = ReadJournal(bytes.NewReader(b)); err != nil {
			return err
		}
		if len(b) > 0 && b[len(b)-1] != '\n' {
			return fmt.Errorf("journal %s: the last line has no line end; the line is torn or edited, so %s", path, recovery)
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	ids, done := map[string]bool{}, map[string]bool{}
	for _, a := range j.Attempts {
		ids[a.ID] = true
	}
	for _, o := range j.Outcomes {
		done[o.Attempt] = true
	}
	var buf bytes.Buffer
	add := func(line any) error {
		b, err := json.Marshal(line)
		buf.Write(append(b, '\n'))
		return err
	}
	for _, a := range attempts {
		if ids[a.ID] {
			return fmt.Errorf("attempt %s is already in the journal %s; a journal is never rewritten, so %s", a.ID, path, recovery)
		}
		if err := checkAttempt(a); err != nil {
			return err
		}
		ids[a.ID] = true
		if err := add(attemptLine{"attempt", a}); err != nil {
			return err
		}
	}
	for _, o := range outcomes {
		switch {
		case !ids[o.Attempt]:
			return fmt.Errorf("outcome for %s: the journal has no attempt %s", o.Attempt, o.Attempt)
		case done[o.Attempt]:
			return fmt.Errorf("attempt %s already has an outcome; outcomes are never corrected", o.Attempt)
		case !slices.Contains([]string{"win", "loss", "ambiguous"}, o.Label):
			return fmt.Errorf("outcome for %s: label %q is not win, loss or ambiguous", o.Attempt, o.Label)
		}
		done[o.Attempt] = true
		if err := add(outcomeLine{"outcome", o}); err != nil {
			return err
		}
	}
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_APPEND|os.O_CREATE, 0o644)
	if err != nil {
		return err
	}
	if _, err := f.Write(buf.Bytes()); err != nil {
		f.Close()
		return err
	}
	return f.Close()
}
