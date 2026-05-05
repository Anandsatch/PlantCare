#!/bin/bash
# Resolve mechanical conflicts after `git rebase origin/main`:
# - VERSION: keep "theirs" (branch's value, monotonically higher)
# - CHANGELOG.md: stack branch's NEW top block above main's existing top block
# - barrel index.ts files: union of all unique export lines (order: main's first, branch's appended)
# Exits non-zero if other conflicts remain.

set -e

while true; do
  conflicts=$(git diff --name-only --diff-filter=U)
  [ -z "$conflicts" ] && break

  # 1. VERSION
  if echo "$conflicts" | grep -q '^VERSION$'; then
    git checkout --theirs -- VERSION
    git add VERSION
    continue
  fi

  # 2. CHANGELOG.md
  if echo "$conflicts" | grep -q '^CHANGELOG\.md$'; then
    python3 - <<'PY'
import re, pathlib
p = pathlib.Path("CHANGELOG.md")
text = p.read_text()
m = re.search(r'<<<<<<< [^\n]*\n(.*?)=======\n(.*?)>>>>>>> [^\n]*\n', text, re.DOTALL)
if not m:
    raise SystemExit("expected conflict markers in CHANGELOG.md not found")
ours = m.group(1).rstrip('\n')
theirs = m.group(2).rstrip('\n')
resolved = theirs + "\n\n" + ours + "\n"
p.write_text(text[:m.start()] + resolved + text[m.end():])
PY
    git add CHANGELOG.md
    continue
  fi

  # 3. Any other index.ts barrel: union of unique export lines on both sides.
  barrel=$(echo "$conflicts" | grep '/index\.ts$' | head -1 || true)
  if [ -n "$barrel" ]; then
    python3 - "$barrel" <<'PY'
import re, sys, pathlib
p = pathlib.Path(sys.argv[1])
text = p.read_text()
m = re.search(r'<<<<<<< [^\n]*\n(.*?)=======\n(.*?)>>>>>>> [^\n]*\n', text, re.DOTALL)
if not m:
    raise SystemExit(f"expected conflict markers in {p} not found")
ours = [l for l in m.group(1).splitlines() if l.strip()]
theirs = [l for l in m.group(2).splitlines() if l.strip()]
seen, merged = set(), []
for l in ours + theirs:
    if l not in seen:
        seen.add(l)
        merged.append(l)
resolved = "\n".join(merged) + "\n"
p.write_text(text[:m.start()] + resolved + text[m.end():])
PY
    git add "$barrel"
    continue
  fi

  echo "UNRESOLVED CONFLICTS in: $conflicts" >&2
  exit 2
done

echo "Conflicts resolved."
