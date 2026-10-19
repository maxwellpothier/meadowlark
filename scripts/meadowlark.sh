#!/bin/sh
# Starts Meadowlark. Rebuilds first if the source changed since the last
# build. It doesn't open a browser tab: reload the one you have.
# Ctrl+C stops the server. Claude's MCP server needs nothing from this: Claude
# Code starts it on its own.
#
# `meadowlark.sh install` runs it in the background instead, as a macOS
# LaunchAgent: started at login, restarted if it crashes, logging to
# ~/Library/Logs/meadowlark.log. `restart` restarts it (after pulling changes,
# say) and `uninstall` removes it.
set -e
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
PORT="${PORT:-5173}"
URL="http://localhost:$PORT"
LABEL="local.meadowlark"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/meadowlark.log"
DOMAIN="gui/$(id -u)"

running() {
  curl -fs -o /dev/null -H "x-meadowlark: 1" "$URL/api/pages"
}

installed() {
  launchctl print "$DOMAIN/$LABEL" > /dev/null 2>&1
}

case "${1:-}" in
  install)
    if running && ! installed; then
      echo "Meadowlark is already running in a terminal. Stop it (Ctrl+C), then run this again."
      exit 1
    fi
    if ! node_path="$(command -v node)"; then
      echo "node isn't on your PATH. Meadowlark needs Node 22.18+."
      exit 1
    fi
    node_dir="$(dirname "$node_path")"
    mkdir -p "$(dirname "$PLIST")" "$(dirname "$LOG")"
    # KeepAlive only on a failed exit: if something else already serves the
    # port, the script exits 0 and launchd leaves it alone.
    cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>/bin/sh</string><string>$ROOT/scripts/meadowlark.sh</string></array>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$node_dir:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>PORT</key><string>$PORT</string>
    <key>MEADOWLARK_AGENT</key><string>1</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
EOF
    launchctl bootout "$DOMAIN/$LABEL" 2> /dev/null || true
    launchctl bootstrap "$DOMAIN" "$PLIST"
    echo "Meadowlark now runs in the background at $URL, and starts at login. Log: $LOG"
    echo "It uses the node in $node_dir. If you remove or switch that version, run install again."
    exit 0
    ;;
  uninstall)
    launchctl bootout "$DOMAIN/$LABEL" 2> /dev/null || true
    rm -f "$PLIST"
    echo "Meadowlark no longer runs in the background."
    exit 0
    ;;
  restart)
    if ! installed; then
      echo "Meadowlark isn't installed to run in the background. Run: $0 install"
      exit 1
    fi
    launchctl kickstart -k "$DOMAIN/$LABEL"
    # A rebuild can take a while; give it up to a minute to answer.
    for _ in $(seq 60); do
      if running; then
        echo "Restarted Meadowlark."
        exit 0
      fi
      sleep 1
    done
    echo "Meadowlark didn't come back within a minute. Check the log: $LOG"
    exit 1
    ;;
  "") ;;
  *)
    echo "Usage: $0 [install | uninstall | restart]"
    exit 2
    ;;
esac

if running; then
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
    # In the background, a failed exit would make launchd rebuild every 10 s.
    # Serve the last good build instead, or stop until the next restart.
    if [ -n "${MEADOWLARK_AGENT:-}" ]; then
      [ -f dist/index.html ] || exit 0
      echo "Serving the last good build."
    else
      exit 1
    fi
  fi
fi

exec npm start --silent
