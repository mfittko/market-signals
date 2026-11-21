// Package settings is the typed settings store in Postgres. Each key has one schema
// entry, secrets are masked on read, and every change adds a revision. The legacy
// settings.json stays the live source: Import mirrors it one way and can rerun.
package settings

import (
	"errors"
	"fmt"
	"math"
	"net/url"
	"regexp"
	"sort"
	"strings"
)

// Origin names the writer. The schema accepts some keys only from some origins.
type Origin string

const (
	FromImport   Origin = "import"   // the settings.json mirror; may carry the engine's file paths
	FromAPI      Origin = "api"      // the console route; refuses paths and job owner flags
	FromOperator Origin = "operator" // the operator route; job owner flags only
)

// Mask replaces each stored secret on read. A write that sends Mask keeps the stored secret.
const Mask = "•••"

// JobKinds each have exactly one owner, "node" or "go". The flags exist only in Postgres.
var JobKinds = []string{"candles", "alerts", "bot", "news"}

// JobOwnerKey is the settings key of one job kind's owner flag.
func JobOwnerKey(kind string) string { return "jobOwner." + kind }

type spec struct {
	check  func(any) error
	secret bool // masked on read
	path   bool // an executable or file path: accepted only from the import
	goOnly bool // a job owner flag: accepted only from the operator route
}

var providers = []string{"pi", "claude-code", "none", "anthropic", "openai", "openai-compatible"}

var schema = func() map[string]spec {
	s := map[string]spec{
		"provider":                  {check: oneOf(providers...)},
		"llmFallbackProvider":       {check: oneOf(providers...)},
		"anthropicThinking":         {check: oneOf("adaptive", "disabled")},
		"model":                     {check: text},
		"models":                    {check: models},
		"port":                      {check: integer(1, 65535)},
		"instrument":                {check: text},
		"instruments":               {check: text},
		"granularity":               {check: text},
		"watchers":                  {check: text},
		"freshBars":                 {check: integer(0, math.MaxInt32)},
		"maxCompletionTokens":       {check: integer(1, math.MaxInt32)},
		"filterMaxCompletionTokens": {check: integer(1, math.MaxInt32)},
		"OPENAI_BASE_URL":           {check: baseURL},
		"sttOpenaiBaseUrl":          {check: baseURL},
		"bot":                       {check: bot},
		"snapshotContext":           {check: boolean},
		"info":                      {check: boolean},
		"ind":                       {check: pattern(`^[a-z,]{1,40}$`)},
		"keepFresh":                 {check: flag},
		"predictionEnabled":         {check: flag},
		"sentinelSourceFootnotes":   {check: flag},
		"PUSHOVER_ENABLED":          {check: flag},
		"NEWSAPI_AI_MODE":           {check: oneOf("auto", "shadow", "off")},
		"NEWSAPI_AI_INSTRUMENTS":    {check: text},
		"NEWSAPI_AI_REQUEST_BUDGET": {check: count},
		"NEWSAPI_AI_BACKGROUND":     {check: flag},
		"GNEWS_MODE":                {check: oneOf("off", "shadow", "auto")},
		"GNEWS_INSTRUMENTS":         {check: text},
		"GNEWS_REQUEST_BUDGET":      {check: count},
		"GNEWS_BACKGROUND":          {check: flag},
		"sttMode":                   {check: oneOf("local", "openai")},
		"sttModel":                  {check: text},
		"cycleMinutes":              {check: granularityMap(1)},
		"uiRefreshSeconds":          {check: granularityMap(2)},
		"impulseVolMult":            {check: number(1)},
		"impulseVolWindow":          {check: integer(1, math.MaxInt32)},
		"impulseCooldownBars":       {check: integer(0, math.MaxInt32)},
	}
	for _, k := range []string{"OPENAI_API_KEY", "ANTHROPIC_API_KEY", "NEWSAPI_AI_KEY", "GNEWS_KEY", "PUSHOVER_TOKEN", "PUSHOVER_USER", "sttOpenaiKey", "TYPESAFE_API_KEY"} {
		s[k] = spec{check: text, secret: true}
	}
	for _, k := range []string{"notesFile", "piBin", "claudeBin", "notifierBin", "sttBin"} {
		s[k] = spec{check: text, path: true}
	}
	for _, k := range JobKinds {
		s[JobOwnerKey(k)] = spec{check: oneOf("node", "go"), goOnly: true}
	}
	return s
}()

// IsSecret reports whether key is masked on read.
func IsSecret(key string) bool { return schema[key].secret }

// Cleared reports whether a posted value deletes the key: null, "" or a blank secret.
func Cleared(key string, v any) bool {
	s, isStr := v.(string)
	return v == nil || (isStr && strings.TrimSpace(s) == "" && (s == "" || IsSecret(key)))
}

// Check validates one key and value for an origin. A nil error means the write may store it.
func Check(o Origin, key string, v any) error {
	sp, ok := schema[key]
	switch {
	case !ok:
		return fmt.Errorf("%s: unknown settings key", key)
	case sp.goOnly != (o == FromOperator):
		if sp.goOnly {
			return fmt.Errorf("%s: writable only through the operator route", key)
		}
		return fmt.Errorf("%s: the operator route writes only job owner flags", key)
	case sp.path && o != FromImport:
		return fmt.Errorf("%s: a file or executable path is not accepted over HTTP", key)
	case Cleared(key, v):
		return nil
	}
	if err := sp.check(v); err != nil {
		return fmt.Errorf("%s: %w", key, err)
	}
	if o != FromImport {
		if p := findPath(v); p != "" {
			return fmt.Errorf("%s: a file or executable path is not accepted over HTTP (%q)", key, p)
		}
	}
	return nil
}

// CheckAll validates a whole patch and reports every refused key, sorted.
func CheckAll(o Origin, patch map[string]any) error {
	var errs []string
	for k, v := range patch {
		if err := Check(o, k, v); err != nil {
			errs = append(errs, err.Error())
		}
	}
	if len(errs) == 0 {
		return nil
	}
	sort.Strings(errs)
	return errors.New(strings.Join(errs, "; "))
}

// findPath returns the first string inside v that names a file system location.
func findPath(v any) string {
	switch t := v.(type) {
	case string:
		if strings.HasPrefix(t, "/") || strings.HasPrefix(t, "~") || strings.HasPrefix(t, "./") ||
			strings.HasPrefix(t, "../") || strings.HasPrefix(t, "file:") || strings.Contains(t, `\`) {
			return t
		}
	case map[string]any:
		for _, x := range t {
			if p := findPath(x); p != "" {
				return p
			}
		}
	}
	return ""
}

func text(v any) error {
	if _, ok := v.(string); !ok {
		return errors.New("must be a string")
	}
	return nil
}

func boolean(v any) error {
	if _, ok := v.(bool); !ok {
		return errors.New("must be true or false")
	}
	return nil
}

// flag is the engine's on/off shape: a boolean or the strings "0" and "1".
func flag(v any) error {
	if s, ok := v.(string); ok && (s == "0" || s == "1") {
		return nil
	}
	if boolean(v) != nil {
		return errors.New(`must be true, false, "0" or "1"`)
	}
	return nil
}

func oneOf(vals ...string) func(any) error {
	return func(v any) error {
		s, _ := v.(string)
		for _, x := range vals {
			if s == x {
				return nil
			}
		}
		return fmt.Errorf("must be one of %s", strings.Join(vals, ", "))
	}
}

func pattern(re string) func(any) error {
	rx := regexp.MustCompile(re)
	return func(v any) error {
		if s, ok := v.(string); !ok || !rx.MatchString(s) {
			return fmt.Errorf("must match %s", re)
		}
		return nil
	}
}

func number(min float64) func(any) error {
	return func(v any) error {
		f, ok := v.(float64)
		if !ok || math.IsNaN(f) || math.IsInf(f, 0) || f < min {
			return fmt.Errorf("must be a number >= %g", min)
		}
		return nil
	}
}

func integer(min, max float64) func(any) error {
	return func(v any) error {
		f, ok := v.(float64)
		if !ok || f != math.Trunc(f) || f < min || f > max {
			return fmt.Errorf("must be an integer from %g to %g", min, max)
		}
		return nil
	}
}

var digitsRx = regexp.MustCompile(`^\d{1,15}$`)

// count is a non-negative integer. The console number field may also send it as digits.
func count(v any) error {
	if s, ok := v.(string); ok && digitsRx.MatchString(s) {
		return nil
	}
	return integer(0, 1e15)(v)
}

func granularityMap(min float64) func(any) error {
	rx := regexp.MustCompile(`^[MH]\d+$`)
	return func(v any) error {
		m, ok := v.(map[string]any)
		if !ok {
			return errors.New("must be an object keyed by granularity")
		}
		for g, x := range m {
			if !rx.MatchString(g) {
				return fmt.Errorf("key %q must be a granularity like M5 or H1", g)
			}
			if err := integer(min, math.MaxInt32)(x); err != nil {
				return fmt.Errorf("[%s] %w", g, err)
			}
		}
		return nil
	}
}

func models(v any) error {
	m, ok := v.(map[string]any)
	if !ok {
		return errors.New("must be an object keyed by provider")
	}
	for p, x := range m {
		if p == "none" || oneOf(providers...)(p) != nil {
			return fmt.Errorf("key %q must be a provider", p)
		}
		if x != nil && text(x) != nil {
			return fmt.Errorf("[%s] must be a model id or null", p)
		}
	}
	return nil
}

func baseURL(v any) error {
	s, _ := v.(string)
	u, err := url.Parse(s)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return errors.New("must be an http(s) URL")
	}
	if u.RawQuery != "" || u.Fragment != "" || u.User != nil {
		return errors.New("must not carry a query, a fragment or credentials")
	}
	return nil
}

var (
	comboRx      = regexp.MustCompile(`^[A-Za-z0-9/ ]{3,20}\|\s*[MH]\d{1,2}$`)
	leverageRx   = regexp.MustCompile(`^[A-Za-z0-9/]{3,20}$`)
	positive     = number(math.SmallestNonzeroFloat64)
	botFieldSpec = map[string]func(any) error{
		"enabled": boolean, "riskPct": positive, "reviewTriggerPct": positive, "killSwitchDrawdownPct": positive,
		"maxPositions": integer(1, math.MaxInt32), "watchers": text, "leverage": leverage, "bots": bots,
	}
	perBotSpec = map[string]func(any) error{
		"enabled": boolean, "strategyId": integer(1, 1<<53), "strategyName": pattern(`^[a-z0-9][a-z0-9-]{1,47}$`),
		"riskPct": positive, "killSwitchDrawdownPct": positive, "allocationPct": func(v any) error {
			if f, ok := v.(float64); !ok || f <= 0 || f > 100 {
				return errors.New("must be in (0,100]")
			}
			return nil
		},
	}
)

// bot is the engine's bot block. Fields may be null; the engine then uses its default.
func bot(v any) error { return object(v, botFieldSpec, "bot.") }

func object(v any, fields map[string]func(any) error, prefix string) error {
	m, ok := v.(map[string]any)
	if !ok {
		return errors.New("must be an object")
	}
	for k, x := range m {
		check, ok := fields[k]
		if !ok {
			return fmt.Errorf("unknown key %s%s", prefix, k)
		}
		if x == nil {
			continue
		}
		if err := check(x); err != nil {
			return fmt.Errorf("%s%s %w", prefix, k, err)
		}
	}
	return nil
}

func leverage(v any) error {
	m, ok := v.(map[string]any)
	if !ok {
		return errors.New("must be an object keyed by instrument")
	}
	for inst, x := range m {
		if !leverageRx.MatchString(inst) {
			return fmt.Errorf("key %q must be an instrument symbol", inst)
		}
		if x != nil && positive(x) != nil {
			return fmt.Errorf("[%s] must be a positive number", inst)
		}
	}
	return nil
}

func bots(v any) error {
	m, ok := v.(map[string]any)
	if !ok {
		return errors.New(`must be an object keyed by "INSTRUMENT|GRANULARITY"`)
	}
	for combo, x := range m {
		if !comboRx.MatchString(combo) {
			return fmt.Errorf(`key %q must be "INSTRUMENT|GRANULARITY"`, combo)
		}
		if x == nil {
			continue
		}
		if err := object(x, perBotSpec, ""); err != nil {
			return fmt.Errorf("[%s] %w", combo, err)
		}
	}
	return nil
}

// NormPair reads a watcher entry the way the engine does: parts are trimmed, case is kept,
// and the timeframe defaults to M5 only when the entry has no separator.
func NormPair(p string) string {
	a, b, hasTF := strings.Cut(p, "|")
	if !hasTF {
		b = "M5"
	}
	return strings.TrimSpace(a) + "|" + strings.TrimSpace(b)
}

// PairSet parses a comma-separated watcher list.
func PairSet(csv string) map[string]bool {
	out := map[string]bool{}
	for _, p := range strings.Split(csv, ",") {
		if strings.TrimSpace(p) != "" {
			out[NormPair(p)] = true
		}
	}
	return out
}

// botsWithoutPair lists each enabled per-combo bot whose pair is not in the watcher list.
// The engine runs a bot only for watched pairs, so such a bot would never trade or close.
// shortcut: the legacy flat bot (bot.enabled without a bots map) is not checked; the
// console has written the bots map since per-combo bots shipped.
func botsWithoutPair(vals map[string]any) []string {
	watched := map[string]bool{}
	if w, ok := vals["watchers"].(string); ok {
		watched = PairSet(w)
	}
	b, _ := vals["bot"].(map[string]any)
	bm, _ := b["bots"].(map[string]any)
	var missing []string
	for combo, x := range bm {
		e, _ := x.(map[string]any)
		if on, _ := e["enabled"].(bool); on && !watched[NormPair(combo)] {
			missing = append(missing, NormPair(combo))
		}
	}
	sort.Strings(missing)
	return missing
}
