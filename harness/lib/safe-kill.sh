#!/usr/bin/env bash
# The ONLY sanctioned way to stop a process from the harness or from an agent.
#
#   source harness/lib/safe-kill.sh
#   safe_kill <pid> [<pid>...]        # SIGTERM, then SIGKILL after 5 s, only for processes we own by name
#   safe_kill_port <port> [<port>...] # same, for whatever listens on the port
#
# Refuses anything that is not one of OUR processes: the harness servers, the local brain, Playwright
# Chromium on a harness profile, the nbcheck runner. Never a parent PID, never PID 1, never the user
# manager (`systemd --user`), never anything whose command line does not match the allow-list.
# Background: 2026-08-26 an agent did `kill $PID $(ps -o ppid= -p $PID)`; the parent of a setsid'd server
# is `systemd --user`, and killing it destroyed the whole desktop session.

_SAFE_KILL_ALLOW='(node .*harness/(serve|fake-drive)\.mjs|node .*harness/run\.mjs|python(3)? -m dayflow\.(api|workers|scheduler)|uvicorn .*dayflow|uv run .*dayflow|chrom(e|ium).*harness/\.profile|chrom(e|ium).*dayflow-theme-shots|uv run --script .*nbcheck)'
_SAFE_KILL_DENY='(^/usr/lib/systemd|^/lib/systemd|systemd --user|gnome-|Xorg|Xwayland|wayland|dbus-daemon|pipewire|pulseaudio|code\b|code\.desktop|/usr/bin/bash$|-bash$|claude$)'

safe_kill() {
  local pid rc=0
  for pid in "$@"; do
    [[ "$pid" =~ ^[0-9]+$ ]] || { echo "safe_kill: not a pid: '$pid'" >&2; rc=1; continue; }
    if [ "$pid" -le 1 ] || [ "$pid" = "$$" ] || [ "$pid" = "$PPID" ]; then
      echo "safe_kill: refusing pid $pid (init / self / parent)" >&2; rc=1; continue
    fi
    local cmd; cmd=$(ps -o args= -p "$pid" 2>/dev/null) || { continue; }  # already gone
    if grep -qE "$_SAFE_KILL_DENY" <<<"$cmd"; then
      echo "safe_kill: REFUSING pid $pid — system/session process: $cmd" >&2; rc=1; continue
    fi
    if ! grep -qE "$_SAFE_KILL_ALLOW" <<<"$cmd"; then
      echo "safe_kill: refusing pid $pid — not a harness/brain/browser process: ${cmd:0:120}" >&2; rc=1; continue
    fi
    kill -TERM "$pid" 2>/dev/null || true
    local i; for i in 1 2 3 4 5 6 7 8 9 10; do kill -0 "$pid" 2>/dev/null || break; sleep 0.5; done
    kill -0 "$pid" 2>/dev/null && kill -KILL "$pid" 2>/dev/null || true
    echo "safe_kill: stopped $pid (${cmd:0:80})"
  done
  return $rc
}

safe_kill_port() {
  local port pid
  for port in "$@"; do
    for pid in $(ss -ltnp 2>/dev/null | grep -E ":$port " | grep -oE 'pid=[0-9]+' | cut -d= -f2 | sort -u); do
      safe_kill "$pid"
    done
  done
}

# Kill a setsid process group ONLY if its leader is one of ours (used by e2e.sh stop()).
safe_kill_group() {
  local pgid=$1
  [[ "$pgid" =~ ^[0-9]+$ ]] || return 1
  local cmd; cmd=$(ps -o args= -p "$pgid" 2>/dev/null) || return 0
  if grep -qE "$_SAFE_KILL_DENY" <<<"$cmd" || ! grep -qE "$_SAFE_KILL_ALLOW" <<<"$cmd"; then
    echo "safe_kill_group: refusing group $pgid — leader is not ours: ${cmd:0:120}" >&2; return 1
  fi
  kill -TERM -- "-$pgid" 2>/dev/null || true
}
