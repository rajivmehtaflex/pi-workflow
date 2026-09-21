#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

if ! git -C "$PACKAGE_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "Error: $PACKAGE_DIR is not inside a Git repository." >&2
  exit 1
fi

REPO_ROOT="$(git -C "$PACKAGE_DIR" rev-parse --show-toplevel)"
PID_FILE="$PACKAGE_DIR/.auto-commit.pid"
LOG_FILE="$PACKAGE_DIR/.auto-commit.log"
INTERVAL="${INTERVAL_SECONDS:-120}"

# Ensure git author identity is available so commit doesn't fail
if [ -z "$(git -C "$REPO_ROOT" config user.name 2>/dev/null || true)" ]; then
  export GIT_AUTHOR_NAME="${GIT_AUTHOR_NAME:-Rajiv Mehta}"
  export GIT_COMMITTER_NAME="${GIT_COMMITTER_NAME:-Rajiv Mehta}"
fi
if [ -z "$(git -C "$REPO_ROOT" config user.email 2>/dev/null || true)" ]; then
  export GIT_AUTHOR_EMAIL="${GIT_AUTHOR_EMAIL:-rajiv.mehta@live.in}"
  export GIT_COMMITTER_EMAIL="${GIT_COMMITTER_EMAIL:-rajiv.mehta@live.in}"
fi

push_to_origin() {
  if git -C "$REPO_ROOT" remote get-url origin >/dev/null 2>&1; then
    local current_branch
    current_branch="$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "main")"
    if git -C "$REPO_ROOT" push -u origin "$current_branch" 2>&1; then
      echo "[$(date '+%Y-%m-%d %H:%M:%S')] Pushed to origin/$current_branch successfully."
    else
      echo "[$(date '+%Y-%m-%d %H:%M:%S')] Warning: git push to origin/$current_branch failed."
    fi
  fi
}

do_commit_cycle() {
  local status_output
  status_output="$(git -C "$REPO_ROOT" status --porcelain)"

  if [ -n "$status_output" ]; then
    local now
    now="$(date '+%Y-%m-%d %H:%M:%S')"
    git -C "$REPO_ROOT" add -A
    if git -C "$REPO_ROOT" diff --cached --quiet; then
      echo "[$now] Changes already staged or clean, skipping commit."
    else
      git -C "$REPO_ROOT" commit -m "chore: auto-commit $now"
      echo "[$now] Committed changes in $(basename "$REPO_ROOT")"
      push_to_origin
    fi
  else
    # Check if there are any unpushed commits
    if git -C "$REPO_ROOT" remote get-url origin >/dev/null 2>&1; then
      local current_branch
      current_branch="$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "main")"
      if [ -n "$(git -C "$REPO_ROOT" log "origin/$current_branch..HEAD" 2>/dev/null || true)" ]; then
        push_to_origin
        return 0
      fi
    fi
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] No changes detected in $(basename "$REPO_ROOT")."
  fi
}

run_loop() {
  echo $$ > "$PID_FILE"
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] Starting auto commit+push loop (PID: $$, monitoring: $(basename "$REPO_ROOT"), interval: ${INTERVAL}s)..."

  cleanup() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] Stopping auto-commit loop..."
    rm -f "$PID_FILE"
    jobs -p | xargs -r kill 2>/dev/null || true
    exit 0
  }

  trap cleanup SIGINT SIGTERM

  while true; do
    do_commit_cycle
    sleep "$INTERVAL" &
    wait $!
  done
}

start_daemon() {
  if [ -f "$PID_FILE" ]; then
    local existing_pid
    existing_pid="$(cat "$PID_FILE" 2>/dev/null || true)"
    if [ -n "$existing_pid" ] && kill -0 "$existing_pid" 2>/dev/null; then
      echo "Auto-commit daemon is already running (PID: $existing_pid)."
      return 0
    fi
    rm -f "$PID_FILE"
  fi

  setsid "$SCRIPT_DIR/auto-commit.sh" run </dev/null >> "$LOG_FILE" 2>&1 &
  sleep 0.2

  if [ -f "$PID_FILE" ]; then
    local new_pid
    new_pid="$(cat "$PID_FILE" 2>/dev/null || true)"
    echo "Auto-commit daemon started in background (PID: $new_pid, interval: ${INTERVAL}s)."
    echo "Logging to: $LOG_FILE"
  else
    echo "Warning: Daemon launched, waiting for PID file..."
  fi
}

stop_daemon() {
  if [ -f "$PID_FILE" ]; then
    local pid
    pid="$(cat "$PID_FILE" 2>/dev/null || true)"
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      pkill -P "$pid" 2>/dev/null || true
      for _ in {1..30}; do
        if ! kill -0 "$pid" 2>/dev/null; then
          break
        fi
        sleep 0.1
      done
      if kill -0 "$pid" 2>/dev/null; then
        kill -9 "$pid" 2>/dev/null || true
      fi
      echo "Auto-commit daemon stopped (PID: $pid)."
    else
      echo "Process with PID $pid not running. Cleaning up stale PID file."
    fi
    rm -f "$PID_FILE"
  else
    echo "Auto-commit daemon is not running (no PID file found)."
  fi
}

status_daemon() {
  if [ -f "$PID_FILE" ]; then
    local pid
    pid="$(cat "$PID_FILE" 2>/dev/null || true)"
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      echo "Auto-commit daemon is RUNNING (PID: $pid, monitoring: $(basename "$REPO_ROOT"), interval: ${INTERVAL}s)."
      if [ -f "$LOG_FILE" ]; then
        echo "Last 5 log entries ($LOG_FILE):"
        tail -n 5 "$LOG_FILE"
      fi
      return 0
    else
      echo "Auto-commit daemon is STOPPED (stale PID file found)."
      return 1
    fi
  else
    echo "Auto-commit daemon is STOPPED."
    return 1
  fi
}

CMD="${1:-run}"
case "$CMD" in
  start)
    start_daemon
    ;;
  stop)
    stop_daemon
    ;;
  status)
    status_daemon
    ;;
  run)
    run_loop
    ;;
  once)
    do_commit_cycle
    ;;
  *)
    echo "Usage: $0 {start|stop|status|run|once}"
    exit 1
    ;;
esac
