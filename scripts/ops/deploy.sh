#!/usr/bin/env bash
# Deploys repo.ing to Railway production from a fresh worktree of origin/main, one service after another, and waits for
# each deployment's result (docs/PRODUCTION.md, "Deploying"). The owner starts deploys; this script is what they run.
#
#   scripts/ops/deploy.sh <expected short sha> <service>...        e.g. scripts/ops/deploy.sh 88426c8 web worker
#
# It deploys only the commit that was reviewed: origin/main must be <expected short sha>, or it stops before anything
# moves. Name web before worker: web's pre-deploy runs the database migrations, the worker's does not. It reads origin/main,
# never the checkout's own files, so it works from a checkout on any branch; to run the reviewed copy of this script
# without updating that checkout:
#
#   git fetch -q origin && git show origin/main:scripts/ops/deploy.sh | bash -s -- <expected short sha> web worker
#
# A worktree is made fresh for each run and removed after it: a long-lived deploy folder in /tmp once lost its .git file
# and package.json to temp cleanup and Railway built a static image from what was left.
set -euo pipefail

EXPECTED=${1:?usage: deploy.sh <expected short sha> <service>... (web, worker)}
shift
[ $# -gt 0 ] || { echo "name at least one service: web, worker" >&2; exit 1; }
for service in "$@"; do
  case $service in web | worker) ;; *) echo "unknown service: $service (web, worker)" >&2; exit 1 ;; esac
done
if [ "$1" = worker ] && printf '%s\n' "$@" | grep -qx web; then
  echo "name web before worker: web runs the migrations the worker may need" >&2; exit 1
fi
PROJECT=${RAILWAY_PROJECT_ID:-507c3e92-c0a7-4c83-8622-172e88509b68}
REPO=$(git rev-parse --show-toplevel)
WORK=${DEPLOY_WORK_DIR:-${TMPDIR:-/tmp}/repoing-deploy}

echo "disk free: $(df -h / | tail -1 | awk '{print $4}')"
git -C "$REPO" fetch -q origin main
SHA=$(git -C "$REPO" rev-parse --short=7 origin/main)
[ "$SHA" = "$EXPECTED" ] || { echo "origin/main is $SHA, expected $EXPECTED; stopping" >&2; exit 1; }

mkdir -p "$WORK"
DIR="$WORK/deploy-$SHA-$$"
[ ! -e "$DIR" ] || { echo "$DIR already exists; stopping" >&2; exit 1; }
git -C "$REPO" worktree add -q --detach "$DIR" origin/main
cleanup() { git -C "$REPO" worktree remove --force "$DIR" 2>/dev/null || true; }
trap cleanup EXIT
[ -f "$DIR/package.json" ] || { echo "no package.json in $DIR; stopping" >&2; exit 1; }
[ -z "$(git -C "$DIR" status --porcelain)" ] || { echo "worktree not clean; stopping" >&2; exit 1; }
[ "$(git -C "$DIR" rev-parse --short=7 HEAD)" = "$SHA" ] || { echo "worktree HEAD mismatch; stopping" >&2; exit 1; }
MESSAGE="$SHA $(git -C "$DIR" log -1 --format=%s | cut -c1-60)"

deploy() {
  local service=$1 output id status=UNKNOWN
  output=$(cd "$DIR" && railway up --project "$PROJECT" --environment production --service "$service" --detach -m "$MESSAGE" 2>&1) \
    || { echo "$output" | tail -5; return 1; }
  id=$(echo "$output" | grep -oE 'id=[0-9a-f-]+' | head -1 | cut -d= -f2)
  [ -n "$id" ] || { echo "no deployment id in railway's output:"; echo "$output" | tail -5; return 1; }
  echo "$service deployment $id started for $MESSAGE"
  for _ in $(seq 1 80); do
    status=$(railway deployment list --project "$PROJECT" --environment production --service "$service" --json 2>/dev/null |
      node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const x=JSON.parse(d).find(x=>x.id===process.argv[1]);console.log(x?x.status:"MISSING")}catch{console.log("ERROR")}})' "$id")
    case $status in SUCCESS | FAILED | CRASHED | REMOVED | SKIPPED) break ;; esac
    sleep 15
  done
  echo "$service deployment $id: $status"
  [ "$status" = SUCCESS ]
}

for service in "$@"; do
  deploy "$service" || { echo "$service did not deploy; stopping before the next service" >&2; exit 1; }
done
echo "disk free: $(df -h / | tail -1 | awk '{print $4}')"
