package db

import (
	"flag"
	"os"
)

// URLFlag registers -db with an empty default, because the flag package prints defaults in usage text and the
// URL carries the password. The returned func, called after parsing, gives -db or else MS_DATABASE_URL.
func URLFlag(fs *flag.FlagSet, usage string) func() string {
	v := fs.String("db", "", usage)
	return func() string {
		if *v != "" {
			return *v
		}
		return os.Getenv("MS_DATABASE_URL")
	}
}
