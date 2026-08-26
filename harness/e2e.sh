#!/usr/bin/env bash
# make e2e helper (PLAN v2 §Harness): fake-wsp on E2E_PORT_BASE, brain on BASE+1, fake-drive on BASE+2.
# Logs + pids under harness/out/. The brain is (re)started per scene so its fake-connector log is
# harness/out/<scene>-connectors.jsonl, as the plan specifies.
# usage: harness/e2e.sh up [scene] | down | run <scene...> | e2e <scene...>      (E2E_REAL=1 → run.mjs --real)
set -uo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
OUT="$ROOT/harness/out"
mkdir -p "$OUT"
BASE=${E2E_PORT_BASE:-8099}
WSP_PORT=$BASE
BRAIN_PORT=$((BASE + 1))
DRIVE_PORT=$((BASE + 2))
export FAKE_WSP_URL="http://127.0.0.1:$WSP_PORT"
export DAYFLOW_URL="http://127.0.0.1:$BRAIN_PORT"
export FAKE_DRIVE_URL="http://127.0.0.1:$DRIVE_PORT"
export DAYFLOW_TOKEN=${DAYFLOW_TOKEN:-dev}
REAL_FLAG=""
[ "${E2E_REAL:-0}" = "1" ] && REAL_FLAG="--real"

wait_for() { # url label logname
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

stop() { # name...
  for name in "$@"; do
    local pidfile="$OUT/$name.pid"
    [ -f "$pidfile" ] || continue
    local pid; pid=$(cat "$pidfile")
    kill -- "-$pid" 2>/dev/null || kill "$pid" 2>/dev/null || true
    rm -f "$pidfile"
  done
}

up_fakes() {
  stop fake-wsp fake-drive
  (cd "$ROOT" && FAKE_WSP_PORT=$WSP_PORT start_bg fake-wsp "$OUT/fake-wsp.log" node harness/serve.mjs)
  (cd "$ROOT" && FAKE_DRIVE_PORT=$DRIVE_PORT FAKE_DRIVE_SCENE="${1:-dev}" start_bg fake-drive "$OUT/fake-drive.log" node harness/fake-drive.mjs)
  wait_for "$FAKE_WSP_URL/health" fake-wsp fake-wsp && wait_for "$FAKE_DRIVE_URL/health" fake-drive fake-drive
}

up_brain() { # scene
  local scene=${1:-dev}
  stop brain
  # DAYFLOW_BUCKET is unset on purpose: the vault store stays in-memory; DAYFLOW_PUBLIC_URL makes artifact links resolvable.
  (cd "$ROOT/backend" && unset DAYFLOW_BUCKET DAYFLOW_FIRESTORE && \
    PORT=$BRAIN_PORT DAYFLOW_TOKEN="$DAYFLOW_TOKEN" DAYFLOW_FAKE_CONNECTORS=1 DAYFLOW_FAKE_LOG="$OUT/$scene-connectors.jsonl" \
    DAYFLOW_PUBLIC_URL="$DAYFLOW_URL" \
    GOOGLE_CLOUD_PROJECT=${GOOGLE_CLOUD_PROJECT:-dayflow-agentic} GOOGLE_GENAI_USE_ENTERPRISE=${GOOGLE_GENAI_USE_ENTERPRISE:-1} \
    GOOGLE_CLOUD_LOCATION=${GOOGLE_CLOUD_LOCATION:-global} PYTHONPATH= \
    start_bg brain "$OUT/brain-$scene.log" uv run python -m dayflow.api)
  wait_for "$DAYFLOW_URL/health" brain "brain-$scene"
}

up() { # [scene]
  local scene=${1:-dev}
  echo "e2e up: fake-wsp :$WSP_PORT, brain :$BRAIN_PORT, fake-drive :$DRIVE_PORT (scene $scene; logs in harness/out/)"
  up_fakes "$scene" && up_brain "$scene"
}

down() {
  stop brain fake-wsp fake-drive
  echo "e2e down"
}

run_scene() { # scene
  echo "=== scene: $1 ${REAL_FLAG} ==="
  (cd "$ROOT" && DAYFLOW_FAKE_LOG="$OUT/$1-connectors.jsonl" node harness/run.mjs "$1" $REAL_FLAG)
}

run() {
  local rc=0
  for scene in "$@"; do run_scene "$scene" || rc=1; done
  return $rc
}

case "${1:-}" in
  up) up "${2:-dev}" ;;
  down) down ;;
  run) shift; run "$@" ;;
  e2e)
    shift
    trap down EXIT
    up_fakes "${1:-dev}" || exit 1
    rc=0
    for scene in "$@"; do
      up_brain "$scene" || { rc=1; continue; }
      run_scene "$scene" || rc=1
    done
    exit $rc
    ;;
  *) echo "usage: $0 up [scene]|down|run <scene...>|e2e <scene...>" >&2; exit 2 ;;
esac
