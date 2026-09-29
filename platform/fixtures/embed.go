// Package fixtures embeds the demo snapshot used for offline runs.
package fixtures

import _ "embed"

//go:embed demo-flip.json
var DemoFlip []byte
