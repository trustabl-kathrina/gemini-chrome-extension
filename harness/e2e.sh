#!/usr/bin/env bash
# make e2e helper: fake-wsp on E2E_PORT_BASE, brain on E2E_PORT_BASE+1, logs + pids under harness/out/.
# usage: harness/e2e.sh up | down | run <scene...> | e2e <scene...>
set -uo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
OUT="$ROOT/harness/out"
mkdir -p "$OUT"
BASE=${E2E_PORT_BASE:-8099}
WSP_PORT=$BASE
BRAIN_PORT=$((BASE + 1))
export FAKE_WSP_URL="http://127.0.0.1:$WSP_PORT"
export DAYFLOW_URL="http://127.0.0.1:$BRAIN_PORT"
export DAYFLOW_TOKEN=${DAYFLOW_TOKEN:-dev}
export DAYFLOW_FAKE_LOG=${DAYFLOW_FAKE_LOG:-/tmp/dayflow-fake-connectors.jsonl}

wait_for() { # url label
  for _ in $(seq 1 90); do
    if curl -fsS -m 2 "$1" >/dev/null 2>&1; then echo "  $2 ready at $1"; return 0; fi
    sleep 1
  done
  echo "  $2 did not answer at $1 within 90s; last log lines:" >&2
  tail -n 20 "$OUT/$3.log" >&2
  return 1
}

start_bg() { # name logfile -- command...
  local name=$1 log=$2; shift 2
  setsid nohup "$@" >"$log" 2>&1 &
  echo $! >"$OUT/$name.pid"
}

up() {
  down >/dev/null 2>&1 || true
  echo "e2e up: fake-wsp :$WSP_PORT, brain :$BRAIN_PORT (logs in harness/out/)"
  (cd "$ROOT" && FAKE_WSP_PORT=$WSP_PORT start_bg fake-wsp "$OUT/fake-wsp.log" node harness/serve.mjs)
  (cd "$ROOT/backend" && PORT=$BRAIN_PORT DAYFLOW_TOKEN="$DAYFLOW_TOKEN" DAYFLOW_FAKE_CONNECTORS=1 DAYFLOW_FAKE_LOG="$DAYFLOW_FAKE_LOG" \
    GOOGLE_CLOUD_PROJECT=${GOOGLE_CLOUD_PROJECT:-dayflow-agentic} GOOGLE_GENAI_USE_ENTERPRISE=${GOOGLE_GENAI_USE_ENTERPRISE:-1} \
    GOOGLE_CLOUD_LOCATION=${GOOGLE_CLOUD_LOCATION:-global} PYTHONPATH= \
    start_bg brain "$OUT/brain.log" uv run python -m dayflow.api)
  wait_for "$FAKE_WSP_URL/health" fake-wsp fake-wsp && wait_for "$DAYFLOW_URL/health" brain brain
}

down() {
  for name in fake-wsp brain; do
    local pidfile="$OUT/$name.pid"
    [ -f "$pidfile" ] || continue
    local pid; pid=$(cat "$pidfile")
    kill -- "-$pid" 2>/dev/null || kill "$pid" 2>/dev/null || true
    rm -f "$pidfile"
  done
  echo "e2e down"
}

run() {
  local rc=0
  for scene in "$@"; do
    echo "=== scene: $scene ==="
    (cd "$ROOT" && node harness/run.mjs "$scene") || rc=1
  done
  return $rc
}

case "${1:-}" in
  up) up ;;
  down) down ;;
  run) shift; run "$@" ;;
  e2e)
    shift
    trap down EXIT
    up || exit 1
    run "$@"
    ;;
  *) echo "usage: $0 up|down|run <scene...>|e2e <scene...>" >&2; exit 2 ;;
esac
