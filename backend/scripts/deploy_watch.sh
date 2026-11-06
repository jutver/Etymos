#!/usr/bin/env bash
# Auto-deploy for the backend server. Runs forever under supervisord
# (program etymos-deploy, see docs/AUTO_DEPLOY.md).
#
# Every DEPLOY_POLL_SECONDS it fetches DEPLOY_BRANCH. When the branch has moved:
#   1. No backend/ changes (frontend, docs): fast-forward only, no restart.
#   2. Backend changes: run the backend tests on the new commit here, in a
#      throwaway worktree (failing tests skip the commit), wait for running
#      checks to finish, fast-forward, restart etymos-api and wait for
#      /api/health. If requirements.txt changed, it's installed before the tests.
#   3. If the API doesn't come back, go back to the previous commit, restart
#      again, and skip the bad commit until a newer one is pushed.
#
# Settings (environment, all optional):
#   DEPLOY_BRANCH          main
#   DEPLOY_POLL_SECONDS    60
#   DEPLOY_DRAIN_SECONDS   1800  longest wait for running checks before restarting anyway
#   DEPLOY_HEALTH_SECONDS  180   how long the restarted API gets to answer /api/health
#   DEPLOY_RUN_TESTS       true  false deploys backend changes without running the tests
#                                (DEPLOY_REQUIRE_CI, its old name, still works)
#   DEPLOY_TEST_SECONDS    1800  longest a test run may take; longer counts as a failure
#   DEPLOY_HEALTH_URL      http://localhost:8000/api/health
set -uo pipefail

BACKEND="$(cd "$(dirname "$0")/.." && pwd)"
REPO="$(cd "$BACKEND/.." && pwd)"
SCRIPT="$BACKEND/scripts/deploy_watch.sh"
PY="$BACKEND/.venv/bin/python"
SV=("$BACKEND/.venv/bin/supervisorctl" -c "$BACKEND/supervisord.conf")
STATE="$BACKEND/logs/deploy_skip"   # last commit that failed the tests or the health check
TEST_LOG="$BACKEND/logs/deploy_tests.log"   # output of the last test run

BRANCH="${DEPLOY_BRANCH:-main}"
POLL="${DEPLOY_POLL_SECONDS:-60}"
DRAIN="${DEPLOY_DRAIN_SECONDS:-1800}"
HEALTH_WAIT="${DEPLOY_HEALTH_SECONDS:-180}"
RUN_TESTS="${DEPLOY_RUN_TESTS:-${DEPLOY_REQUIRE_CI:-true}}"
TEST_WAIT="${DEPLOY_TEST_SECONDS:-1800}"
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

# Run the backend tests on commit $1 in a throwaway worktree with the server's
# venv, so neither the live checkout nor the running API is touched. If
# requirements.txt changed ($2 = true), install the new one into the venv first.
# Output goes to TEST_LOG. Returns pytest's exit code (124 on timeout).
run_tests() {
  local commit="$1" reqs="$2" dir rc
  dir="$(mktemp -d "${TMPDIR:-/tmp}/etymos-deploy-test.XXXXXX")"
  if ! git_ worktree add -q --detach "$dir" "$commit"; then
    rm -rf "$dir"
    echo "git worktree add failed" >"$TEST_LOG"
    return 1
  fi
  if [ "$reqs" = "true" ]; then
    log "requirements.txt changed; installing it before the tests"
    "$BACKEND/.venv/bin/pip" install -q -r "$dir/backend/requirements.txt"
  fi
  log "Running the backend tests on $(short "$commit")"
  local tmo=()
  command -v timeout >/dev/null && tmo=(timeout "$TEST_WAIT")
  ( cd "$dir/backend" && ${tmo[@]+"${tmo[@]}"} nice -n 10 "$PY" -m pytest -q -p no:cacheprovider ) >"$TEST_LOG" 2>&1
  rc=$?
  git_ worktree remove --force "$dir" >/dev/null 2>&1 || rm -rf "$dir"
  git_ worktree prune
  return $rc
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

# pytest's last "N passed, M failed" line, or the log's last line.
test_summary() {
  grep -E '[0-9]+ (passed|failed|errors?)' "$TEST_LOG" | tail -n 1 | grep . || tail -n 1 "$TEST_LOG"
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
  log "Installing requirements.txt"
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

  local reqs=false
  grep -qx 'backend/requirements.txt' <<<"$changed" && reqs=true
  local install=$reqs  # still to install before the restart

  clean_runtime_files || return 1  # before testing: no point if this blocks

  if [ "$RUN_TESTS" = "true" ]; then
    local rc=0
    run_tests "$new" "$reqs" || rc=$?
    if [ "$rc" -ne 0 ]; then
      [ "$rc" -eq 124 ] && log "Tests on $(short "$new") took over ${TEST_WAIT}s"
      log "Skipping $(short "$new"): tests failed ($(test_summary)); see logs/deploy_tests.log"
      echo "$new" >"$STATE"
      $reqs && install_requirements  # put the live version's requirements back
      return 0
    fi
    log "Tests passed on $(short "$new")"
    install=false  # run_tests installed them
  fi

  wait_for_idle
  clean_runtime_files || return 1  # again: running checks may have written to the cache
  if ! git_ merge -q --ff-only "$new"; then
    log "Fast-forward to $(short "$new") failed (was the branch force-pushed?); fix by hand"
    echo "$new" >"$STATE"
    return 1
  fi
  log "Deploying $(short "$old") -> $(short "$new"): $(git_ log -1 --format=%s "$new")"

  if { ! $install || install_requirements; } && restart_and_check; then
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

log "Watching origin/$BRANCH every ${POLL}s (tests: $RUN_TESTS)"
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
