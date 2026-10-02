# Sourced by switch-launchd.sh and backup.sh. Prints the main checkout for the git repo at $1.
# The absolute path format keeps the result independent of the caller's cwd: on the main checkout
# plain --git-common-dir prints a relative ".git".
main_root() { (cd "$(git -C "$1" rev-parse --path-format=absolute --git-common-dir)/.." && pwd); }
