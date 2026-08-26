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
# The brain is addressed as `localhost`, the fakes as `127.0.0.1`: different host names, so the runner can leave
# the brain OFF the seeded allow-list and the implicit brain-host rule (download/open_tab of report pages) is
# exercised for real instead of being masked by a shared 127.0.0.1 entry.
export DAYFLOW_URL="http://localhost:$BRAIN_PORT"
export FAKE_DRIVE_URL="http://127.0.0.1:$DRIVE_PORT"
export DAYFLOW_TOKEN=${DAYFLOW_TOKEN:-dev}
REAL_FLAG=""
[ "${E2E_REAL:-0}" = "1" ] && REAL_FLAG="--real"
# Headed Chromium needs a display; default to the new headless mode when there is none (CI, ssh).
if [ -z "${HARNESS_HEADLESS:-}" ] && [ -z "${DISPLAY:-}" ] && [ -z "${WAYLAND_DISPLAY:-}" ]; then
  export HARNESS_HEADLESS=1
fi

# Machine dependencies that fail late and confusingly otherwise: Vertex ADC + project, Node ≥ 22.18 (TypeScript
# stripping in run.mjs), Playwright's Chromium, uv (brain + nbcheck venvs), the extension build.
preflight() {
  local ok=1
  if ! command -v uv >/dev/null 2>&1; then echo "preflight: uv not found (https://docs.astral.sh/uv/)" >&2; ok=0; fi
  local nodev; nodev=$(node -p "process.versions.node" 2>/dev/null || echo 0)
  if ! node -e "const [a,b]=process.versions.node.split('.').map(Number); process.exit(a>22||(a===22&&b>=18)?0:1)" 2>/dev/null; then
    echo "preflight: Node >= 22.18 required (found $nodev): harness/run.mjs imports the extension's .ts files natively" >&2; ok=0
  fi
  if [ ! -f "$ROOT/extension/.output/chrome-mv3/manifest.json" ]; then
    echo "preflight: extension build missing — run: make extension-build (or cd extension && pnpm build)" >&2; ok=0
  fi
  if ! (cd "$ROOT/extension" && node -e "require('playwright')" 2>/dev/null); then
    echo "preflight: playwright is not installed under extension/node_modules — run: make e2e-setup" >&2; ok=0
  elif ! (cd "$ROOT/extension" && node -e "const {chromium}=require('playwright'); const p=chromium.executablePath(); if(!require('fs').existsSync(p)) process.exit(1)" 2>/dev/null); then
    echo "preflight: Playwright's Chromium is not installed — run: make e2e-setup (pnpm exec playwright install chromium)" >&2; ok=0
  fi
  if [ "${GOOGLE_GENAI_USE_ENTERPRISE:-1}" = "1" ] && [ -z "${GOOGLE_API_KEY:-}" ]; then
    if [ -z "${GOOGLE_CLOUD_PROJECT:-}" ]; then
      GOOGLE_CLOUD_PROJECT=$(gcloud config get-value project 2>/dev/null || true)
      if [ -n "$GOOGLE_CLOUD_PROJECT" ]; then
        echo "preflight: GOOGLE_CLOUD_PROJECT is unset — using the active gcloud project '$GOOGLE_CLOUD_PROJECT' for Vertex AI (export GOOGLE_CLOUD_PROJECT to override)"
        export GOOGLE_CLOUD_PROJECT
      else
        echo "preflight: set GOOGLE_CLOUD_PROJECT (a project with Vertex AI enabled) or GOOGLE_API_KEY" >&2; ok=0
      fi
    fi
    if ! gcloud auth application-default print-access-token >/dev/null 2>&1; then
      echo "preflight: no Application Default Credentials — run: gcloud auth application-default login" >&2; ok=0
    fi
  fi
  [ "$ok" = 1 ] || { echo "preflight failed; see README 'Harness (make e2e)'" >&2; return 1; }
  echo "preflight ok: node $nodev, project ${GOOGLE_CLOUD_PROJECT:-<api key>}, headless=${HARNESS_HEADLESS:-0}"
}

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

# A restarted server must not race its predecessor's graceful shutdown (uvicorn keeps the port for a moment and
# would still answer /health while the new process fails to bind). Wait until nothing answers any more.
wait_free() { # url label
  for _ in $(seq 1 40); do
    curl -fsS -m 1 "$1" >/dev/null 2>&1 || return 0
    sleep 0.5
  done
  echo "  $2 still answers at $1 after 20s; is another instance running?" >&2
  return 1
}

up_fakes() {
  stop fake-wsp fake-drive
  wait_free "$FAKE_WSP_URL/health" fake-wsp && wait_free "$FAKE_DRIVE_URL/health" fake-drive || return 1
  (cd "$ROOT" && FAKE_WSP_PORT=$WSP_PORT start_bg fake-wsp "$OUT/fake-wsp.log" node harness/serve.mjs)
  (cd "$ROOT" && FAKE_DRIVE_PORT=$DRIVE_PORT FAKE_DRIVE_SCENE="${1:-dev}" start_bg fake-drive "$OUT/fake-drive.log" node harness/fake-drive.mjs)
  wait_for "$FAKE_WSP_URL/health" fake-wsp fake-wsp && wait_for "$FAKE_DRIVE_URL/health" fake-drive fake-drive
}

up_brain() { # scene
  local scene=${1:-dev}
  stop brain
  wait_free "$DAYFLOW_URL/health" brain || return 1
  # DAYFLOW_BUCKET is unset on purpose: the vault store stays in-memory; DAYFLOW_PUBLIC_URL makes artifact links resolvable.
  (cd "$ROOT/backend" && unset DAYFLOW_BUCKET DAYFLOW_FIRESTORE && \
    PORT=$BRAIN_PORT DAYFLOW_TOKEN="$DAYFLOW_TOKEN" DAYFLOW_FAKE_CONNECTORS=1 DAYFLOW_FAKE_LOG="$OUT/$scene-connectors.jsonl" \
    DAYFLOW_PUBLIC_URL="$DAYFLOW_URL" \
    GOOGLE_CLOUD_PROJECT="${GOOGLE_CLOUD_PROJECT:-}" GOOGLE_GENAI_USE_ENTERPRISE=${GOOGLE_GENAI_USE_ENTERPRISE:-1} \
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
  up) preflight && up "${2:-dev}" ;;
  down) down ;;
  run) shift; preflight && run "$@" ;;
  e2e)
    shift
    preflight || exit 1
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
