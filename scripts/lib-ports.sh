# Sourced by the test and e2e scripts (not run): free-port selection and bounded waits, so a script never collides
# with a harness or dev stack that is already running, and never waits for ever.
#
#   port_in_use PORT                     true when something listens on 127.0.0.1:PORT
#   pick_port VAR DEFAULT                sets VAR. $VAR from the environment wins and must be free (a busy one is an
#                                        error that says so); otherwise DEFAULT, or the next free port above it when
#                                        DEFAULT is busy (a note on stderr). Ports picked here are never handed out twice.
#   wait_http URL SECONDS [PID]          true once URL answers 2xx; false after SECONDS or when PID has exited
#   wait_until SECONDS DESCRIPTION CMD...  retries CMD (output dropped) until it succeeds or SECONDS pass, else `fail`
#
# The caller defines `fail MESSAGE` (it must exit); a fallback is provided here.
declare -F fail >/dev/null 2>&1 || fail() { echo "FAIL: $*" >&2; exit 1; }
PICKED_PORTS=" "

port_in_use() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }

pick_port() {
  local var=$1 default=$2 want="${!1:-}" p tries=0
  if [[ -n "$want" ]]; then
    [[ "$want" =~ ^[0-9]+$ ]] || fail "$var needs a port number (got '$want')"
    if port_in_use "$want" || [[ "$PICKED_PORTS" == *" $want "* ]]; then
      fail "port $want ($var) is already in use; stop what listens there or set $var to a free port"
    fi
    PICKED_PORTS="$PICKED_PORTS$want "
    return 0
  fi
  p=$default
  while port_in_use "$p" || [[ "$PICKED_PORTS" == *" $p "* ]]; do
    p=$((p + 1)); tries=$((tries + 1))
    [[ $tries -le 200 ]] || fail "no free port found from $default upwards for $var"
  done
  [[ "$p" == "$default" ]] || echo "note: default port $default for $var is busy; using $p" >&2
  PICKED_PORTS="$PICKED_PORTS$p "
  printf -v "$var" '%s' "$p"
}

wait_http() {
  local url=$1 secs=$2 pid=${3:-} end=$((SECONDS + $2))
  while [[ $SECONDS -lt $end ]]; do
    command curl -fsS --max-time 5 -o /dev/null "$url" 2>/dev/null && return 0
    [[ -z "$pid" ]] || kill -0 "$pid" 2>/dev/null || return 1
    sleep 0.2
  done
  return 1
}

wait_until() {
  local secs=$1 what=$2 end=$((SECONDS + $1)); shift 2
  while [[ $SECONDS -lt $end ]]; do
    "$@" >/dev/null 2>&1 && return 0
    sleep 0.2
  done
  fail "timed out after ${secs}s waiting for $what"
}
