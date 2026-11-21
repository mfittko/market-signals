# Sourced by switch-launchd.sh and backup.sh. Prints the main checkout for the git repo at $1.
# The absolute path format keeps the result independent of the caller's cwd: on the main checkout
# plain --git-common-dir prints a relative ".git".
# A git failure returns nonzero instead of printing "/", and pwd -P gives the physical path that callers compare.
main_root() { local d; d="$(git -C "$1" rev-parse --path-format=absolute --git-common-dir)" || return; (cd "$d/.." && pwd -P); }
