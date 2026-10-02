// Package migrations embeds the versioned SQL files applied by db.Migrate.
package migrations

import "embed"

//go:embed *.sql
var FS embed.FS
