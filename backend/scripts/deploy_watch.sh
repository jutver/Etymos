#!/usr/bin/env bash
# Auto-deploy for the backend server. Runs forever under supervisord
# (program etymos-deploy, see docs/AUTO_DEPLOY.md).
#
# Every DEPLOY_POLL_SECONDS it fetches DEPLOY_BRANCH. When the branch has moved:
#   1. No backend/ changes (frontend, docs): fast-forward only, no restart.
#   2. Backend changes: wait for the "backend-tests" GitHub Actions check on
#      that commit to pass (a failed check skips the commit), wait for running
#      checks to finish, fast-forward, pip install if requirements.txt changed,
#      restart etymos-api and wait for /api/health.
#   3. If the API doesn't come back, go back to the previous commit, restart
#      again, and skip the bad commit until a newer one is pushed.
#
# Settings (environment, all optional):
#   DEPLOY_BRANCH          main
#   DEPLOY_POLL_SECONDS    60
#   DEPLOY_DRAIN_SECONDS   1800  longest wait for running checks before restarting anyway
#   DEPLOY_HEALTH_SECONDS  180   how long the restarted API gets to answer /api/health
#   DEPLOY_REQUIRE_CI      true  false deploys backend changes without waiting for CI
#   DEPLOY_HEALTH_URL      http://localhost:8000/api/health
#   GITHUB_TOKEN                 only to raise GitHub's 60 requests/hour limit
set -uo pipefail

BACKEND="$(cd "$(dirname "$0")/.." && pwd)"
REPO="$(cd "$BACKEND/.." && pwd)"
SCRIPT="$BACKEND/scripts/deploy_watch.sh"
PY="$BACKEND/.venv/bin/python"
SV=("$BACKEND/.venv/bin/supervisorctl" -c "$BACKEND/supervisord.conf")
STATE="$BACKEND/logs/deploy_skip"   # last commit that failed CI or the health check
GITHUB_REPO="jutver/Etymos"
CHECK_NAME="backend-tests"

BRANCH="${DEPLOY_BRANCH:-main}"
POLL="${DEPLOY_POLL_SECONDS:-60}"
DRAIN="${DEPLOY_DRAIN_SECONDS:-1800}"
HEALTH_WAIT="${DEPLOY_HEALTH_SECONDS:-180}"
REQUIRE_CI="${DEPLOY_REQUIRE_CI:-true}"
HEALTH_URL="${DEPLOY_HEALTH_URL:-http://localhost:8000/api/health}"

log() { echo "$(date '+%F %T') $*"; }

# For conditions re-checked every poll: log only when the message changes.
LAST_NOTE=""
note() { [ "$*" != "$LAST_NOTE" ] && log "$*"; LAST_NOTE="$*"; }

git_() { git -C "$REPO" "$@"; }

short() { echo "${1:0:7}"; }

# Field of the /api/health JSON, empty when the API doesn't answer.
health_field() {
  curl -fsS --max-time 5 "$HEALTH_URL" 2>/dev/null \
    | "$PY" -c "import json,sys; print(json.load(sys.stdin).get('$1', ''))" 2>/dev/null
}

# success, failure or pending, for the backend-tests check on commit $1.
ci_state() {
  local auth=()
  [ -n "${GITHUB_TOKEN:-}" ] && auth=(-H "Authorization: Bearer $GITHUB_TOKEN")
  curl -fsS --max-time 15 ${auth[@]+"${auth[@]}"} -H "Accept: application/vnd.github+json" \
    "https://api.github.com/repos/$GITHUB_REPO/commits/$1/check-runs?check_name=$CHECK_NAME" 2>/dev/null \
    | "$PY" -c '
import json, sys
runs = json.load(sys.stdin).get("check_runs", [])
if not runs:
    print("pending")  # the workflow hasn'"'"'t started yet
else:
    run = max(runs, key=lambda r: r.get("started_at") or "")
    if run["status"] != "completed":
        print("pending")
    elif run["conclusion"] in ("success", "skipped", "neutral"):
        print("success")
    else:
        print("failure")
' 2>/dev/null || echo "pending"
}

# The server writes into some tracked files (paper cache, .pyc). Put them back
# so the fast-forward can't be refused; stop if anything else was edited by hand.
clean_runtime_files() {
  local dirty other
  dirty="$(git_ diff --name-only HEAD)"
  [ -z "$dirty" ] && return 0
  other="$(grep -v -e '/__pycache__/' -e '^backend/paper_cache/' <<<"$dirty")"
  if [ -n "$other" ]; then
    note "Not deploying: files changed by hand on this server (commit them elsewhere, or git checkout -- <file>):" $other
    return 1
  fi
  git_ checkout -- $dirty
}

wait_for_idle() {
  local waited=0 jobs
  while :; do
    jobs="$(health_field active_jobs)"
    [ -z "$jobs" ] || [ "$jobs" = "0" ] && return 0
    if [ "$waited" -ge "$DRAIN" ]; then
      log "Still $jobs check(s) running after ${DRAIN}s; restarting anyway"
      return 0
    fi
    [ "$waited" -eq 0 ] && log "Waiting for $jobs running check(s) to finish"
    sleep 10
    waited=$((waited + 10))
  done
}

install_requirements() {
  log "requirements.txt changed; installing"
  "$BACKEND/.venv/bin/pip" install -q -r "$BACKEND/requirements.txt"
}

restart_and_check() {
  "${SV[@]}" restart etymos-api >/dev/null
  local waited=0
  while [ "$waited" -lt "$HEALTH_WAIT" ]; do
    sleep 5
    waited=$((waited + 5))
    [ "$(health_field status)" = "ok" ] && return 0
  done
  return 1
}

deploy() {
  local old="$1" new="$2" changed
  changed="$(git_ diff --name-only "$old" "$new")"

  if ! grep -q '^backend/' <<<"$changed"; then
    clean_runtime_files || return 1
    git_ merge -q --ff-only "$new" && log "Updated to $(short "$new") (no backend changes, no restart)"
    return
  fi

  if [ "$REQUIRE_CI" = "true" ]; then
    case "$(ci_state "$new")" in
      pending) note "Waiting for the $CHECK_NAME check on $(short "$new")"; return 0 ;;
      failure)
        log "Skipping $(short "$new"): the $CHECK_NAME check failed on GitHub"
        echo "$new" >"$STATE"
        return 0 ;;
    esac
  fi

  clean_runtime_files || return 1  # before waiting: no point draining if this blocks
  wait_for_idle
  clean_runtime_files || return 1  # again: running checks may have written to the cache
  if ! git_ merge -q --ff-only "$new"; then
    log "Fast-forward to $(short "$new") failed (was the branch force-pushed?); fix by hand"
    echo "$new" >"$STATE"
    return 1
  fi
  log "Deploying $(short "$old") -> $(short "$new"): $(git_ log -1 --format=%s "$new")"

  local reqs=false
  grep -qx 'backend/requirements.txt' <<<"$changed" && reqs=true
  if { ! $reqs || install_requirements; } && restart_and_check; then
    log "Deployed $(short "$new")"
  else
    log "Deploy of $(short "$new") failed; rolling back to $(short "$old")"
    echo "$new" >"$STATE"
    git_ reset -q --keep "$old"
    $reqs && install_requirements
    if restart_and_check; then
      log "Rolled back to $(short "$old"); see logs/api.err.log for why $(short "$new") failed"
    else
      log "API still down after rolling back; check logs/api.err.log"
    fi
  fi

  # Pick up a new version of this script.
  if grep -qx 'backend/scripts/deploy_watch.sh' <<<"$changed"; then
    log "deploy_watch.sh changed; restarting it"
    exec "$SCRIPT"
  fi
}

log "Watching origin/$BRANCH every ${POLL}s (CI required: $REQUIRE_CI)"
while :; do
  if [ "$(git_ rev-parse --abbrev-ref HEAD)" != "$BRANCH" ]; then
    note "The checkout isn't on $BRANCH; not deploying until it is"
  elif git_ fetch -q origin "$BRANCH" 2>/dev/null; then
    old="$(git_ rev-parse HEAD)"
    new="$(git_ rev-parse "origin/$BRANCH")"
    if [ "$old" != "$new" ] && [ "$new" != "$(cat "$STATE" 2>/dev/null)" ]; then
      if git_ merge-base --is-ancestor "$old" "$new"; then
        deploy "$old" "$new"
      else
        log "HEAD $(short "$old") isn't behind origin/$BRANCH (local commits or a force-push); not deploying"
        echo "$new" >"$STATE"
      fi
    fi
  else
    note "git fetch failed; retrying"
  fi
  sleep "$POLL"
done
