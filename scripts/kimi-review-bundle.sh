#!/usr/bin/env bash
# Erzeugt ein Review-Bundle für den Kimi-K3-Code-Review (docs/parity/RUNBOOK.md §3).
#
# Aufruf:  scripts/kimi-review-bundle.sh <worktree> <base-ref> <out-file> [max-file-bytes]
#
# Deckt Änderungen + neue (untracked) Dateien ab. Zwei bekannte git-Fallen werden
# umgangen (beide gefunden beim M1-14/M1-15-Review, 2026-09-03):
#   1. `git show rev:path` liefert für NICHT existente Pfade mit "["-Zeichen
#      Exit 0 + leere Ausgabe (Glob-Magic) -> Existenzprüfung via `git ls-tree`
#      mit `:(literal)`-Pathspec.
#   2. `git diff rev -- "app/.../[workspaceId]/..."` matcht wegen Glob-Magic
#      nichts -> immer `:(literal)`-Pathspec verwenden.
set -euo pipefail

dir="${1:?worktree}"
base="${2:?base-ref}"
out="${3:?out-file}"
max_bytes="${4:-0}"

cd "$dir"
: > "$out"

{
  git diff --name-only "$base"
  git ls-files --others --exclude-standard
} | sort -u | grep -vE 'node_modules|package-lock\.json|drizzle/meta/|(^|/)\.env' \
  | while IFS= read -r f; do
      tracked=""
      if git ls-tree -r --name-only "$base" -- ":(literal)$f" | grep -qxF "$f"; then
        tracked=1
      fi
      if [ -n "$tracked" ]; then
        diff_content=$(git diff "$base" -- ":(literal)$f")
        if [ -n "$diff_content" ]; then
          { echo "=== DIFF: $f ==="; printf '%s\n' "$diff_content"; } >> "$out"
        fi
      else
        size=$(wc -c < "$f" | tr -d ' ')
        if [ "$max_bytes" -gt 0 ] && [ "$size" -gt "$max_bytes" ]; then
          echo "SKIP big new file: $f ($size bytes)" >&2
          continue
        fi
        { echo "=== NEU: $f ==="; cat "$f"; } >> "$out"
      fi
    done

wc -c "$out" >&2
