#!/bin/sh
# Starts Meadowlark. Rebuilds first if the source changed since the last
# build. It doesn't open a browser tab: reload the one you have.
# Ctrl+C stops the server. Claude's MCP server needs nothing from this: Claude
# Code starts it on its own.
set -e
cd "$(dirname "$0")/.."
PORT="${PORT:-5173}"
URL="http://localhost:$PORT"

if curl -fs -o /dev/null -H "x-meadowlark: 1" "$URL/api/pages"; then
  echo "Meadowlark is already running at $URL"
  exit 0
fi

[ -d node_modules ] || npm install
if [ ! -f dist/index.html ] || [ -n "$(find src server public/favicon.svg index.html package.json vite.config.ts -newer dist/index.html -print -quit)" ]; then
  # The build lists every output file; keep that out of the way unless it fails.
  log="${TMPDIR:-/tmp}/meadowlark-build.log"
  echo "Source changed since the last build. Rebuilding…"
  if ! npm run build > "$log" 2>&1; then
    cat "$log"
    echo "Build failed (log: $log)"
    exit 1
  fi
fi

exec npm start --silent
