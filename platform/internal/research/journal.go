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
	// Expiry depends on the mode. A retrospective attempt expires at the decision time plus
	// maxBars bar durations on the wall clock. It does not skip market gaps, while the E0 time
	// stop counts bars, so a trade that spans a weekend matures after its attempt's expiry.
	// A prospective attempt expires at the decision time plus the spec's timing.expiryDays
	// calendar days.
	Expiry time.Time `json:"expiry"`
	// Received is when a prospective attempt's loop first saw its bar complete. It is
	// omitted when zero, so retrospective journals keep their bytes.
	Received time.Time `json:"received,omitzero"`
}

type Outcome struct {
	Attempt      string    `json:"attempt"`
	LabelVersion string    `json:"labelVersion"`
	Matured      time.Time `json:"matured"`
	NetR         float64   `json:"netR"`
	Label        string    `json:"label"`          // win | loss | ambiguous
	Exit         string    `json:"exit,omitempty"` // sma5 | time | stop; empty on retrospective outcomes
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
	case a.Mode == "prospective" && a.Received.IsZero():
		return fmt.Errorf("attempt %s: a prospective attempt needs a received time", a.ID)
	case a.Mode == "prospective" && a.Received.Before(a.Decision):
		return fmt.Errorf("attempt %s: received %s is before its decision %s", a.ID, a.Received.Format(time.RFC3339), a.Decision.Format(time.RFC3339))
	}
	return nil
}

// records holds the attempt ids and outcomes a journal has so far, so a read and an
// append refuse the same records.
type records struct {
	status map[string]string // attempt id to status
	done   map[string]bool   // attempt ids that have an outcome
}

func newRecords() records { return records{map[string]string{}, map[string]bool{}} }

func (r records) attempt(a Attempt) error {
	if _, ok := r.status[a.ID]; ok {
		return fmt.Errorf("attempt %s is already in the journal; a journal is never rewritten", a.ID)
	}
	if err := checkAttempt(a); err != nil {
		return err
	}
	r.status[a.ID] = a.Status
	return nil
}

func (r records) outcome(o Outcome) error {
	status, ok := r.status[o.Attempt]
	switch {
	case !ok:
		return fmt.Errorf("outcome for %s: the journal has no attempt %s", o.Attempt, o.Attempt)
	case status != "forecast":
		return fmt.Errorf("outcome for %s: the attempt is a %s, and only a forecast has an outcome", o.Attempt, status)
	case r.done[o.Attempt]:
		return fmt.Errorf("attempt %s already has an outcome; outcomes are never corrected", o.Attempt)
	case o.LabelVersion != LabelVersion:
		return fmt.Errorf("outcome for %s: label version %q is not %s", o.Attempt, o.LabelVersion, LabelVersion)
	case !slices.Contains([]string{"win", "loss", "ambiguous"}, o.Label):
		return fmt.Errorf("outcome for %s: label %q is not win, loss or ambiguous", o.Attempt, o.Label)
	case !slices.Contains([]string{"", "sma5", "time", "stop"}, o.Exit):
		return fmt.Errorf("outcome for %s: exit %q is not sma5, time or stop", o.Attempt, o.Exit)
	}
	r.done[o.Attempt] = true
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

// ReadJournal refuses an unparsable line, and a line that Append would refuse, and names
// its line number.
func ReadJournal(r io.Reader) (Journal, error) {
	j, _, err := readJournal(r)
	return j, err
}

func readJournal(r io.Reader) (Journal, records, error) {
	var j Journal
	recs := newRecords()
	sc := bufio.NewScanner(r)
	sc.Buffer(nil, 1<<20)
	line := 1
	for ; sc.Scan(); line++ {
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
				err = recs.attempt(a.Attempt)
				j.Attempts = append(j.Attempts, a.Attempt)
			}
		case kind.Kind == "outcome":
			var o outcomeLine
			if err = d.Decode(&o); err == nil {
				err = recs.outcome(o.Outcome)
				j.Outcomes = append(j.Outcomes, o.Outcome)
			}
		default:
			err = fmt.Errorf("kind %q is not attempt or outcome", kind.Kind)
		}
		if err != nil {
			return j, recs, fmt.Errorf("journal line %d: %w; the line is torn or edited, so %s", line, err, recovery)
		}
	}
	// a scan error, such as a line over the buffer, stops at the line it could not read
	if err := sc.Err(); err != nil {
		return j, recs, fmt.Errorf("journal line %d: %w; the line is torn or edited, so %s", line, err, recovery)
	}
	return j, recs, nil
}

// Append adds the records as one line each, in one write call. It refuses the whole batch,
// and leaves the file unchanged, when the last line has no line end, an attempt id is
// already in the journal, or an outcome's attempt is missing, is not a forecast or already
// has an outcome. It never rewrites a line. A failed write can leave a torn last line,
// which a later read or append refuses, so the recovery is to build a new journal at a new
// path. It takes no lock: two concurrent appends can both write, and the next read refuses
// the duplicated records.
func Append(path string, attempts []Attempt, outcomes []Outcome) error {
	recs := newRecords()
	if b, err := os.ReadFile(path); err == nil {
		if _, recs, err = readJournal(bytes.NewReader(b)); err != nil {
			return err
		}
		if len(b) > 0 && b[len(b)-1] != '\n' {
			return fmt.Errorf("journal %s: the last line has no line end; the line is torn or edited, so %s", path, recovery)
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	refuse := func(err error) error {
		return fmt.Errorf("journal %s: %w; the batch is refused and the file is unchanged, so %s", path, err, recovery)
	}
	var buf bytes.Buffer
	add := func(line any) error {
		b, err := json.Marshal(line)
		buf.Write(append(b, '\n'))
		return err
	}
	for _, a := range attempts {
		if err := recs.attempt(a); err != nil {
			return refuse(err)
		}
		if err := add(attemptLine{"attempt", a}); err != nil {
			return err
		}
	}
	for _, o := range outcomes {
		if err := recs.outcome(o); err != nil {
			return refuse(err)
		}
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
