#!/usr/bin/env bash
# Hooks release check: runs the complete hooks suite WITH the private generated artifacts, so no test may skip for a
# missing artifact. Exits non-zero on any failed or cancelled test, and on any skip whose reason starts with
# "missing private hook artifact". Prints a final summary (tests/pass/fail/skip and every skip reason).
#
# Usage: scripts/hooks-release-check.sh [test files...]   (default: every hook test file, see HOOK_TESTS below)
#
# Artifact locations come from the environment. Defaults are the maintainer Mac's private state:
#   HOOKS_LOCAL_STATE                        $HOME/Documents/ChatGPT/hooks-local-state
#   HOOKLAB_GENERATED_FIXTURE_DIR            $HOOKS_LOCAL_STATE/historical-fixture-recovery-8aedbb40/fixtures
#                                            (max-wallet, buy/sell and custom-hook Rust vectors, buy/sell app plans)
#   HOOKLAB_INCLUSIVE_GENERATED_FIXTURE_DIR  $HOOKS_LOCAL_STATE/rebuilt-inclusive/evidence
#   HOOKLAB_INCLUSIVE_TOKEN_ELF              $HOOKS_LOCAL_STATE/rebuilt-inclusive/elf/bordrless_token.so
#   HOOKLAB_CANARY_ELF_DIR                   $HOOKS_LOCAL_STATE/rebuilt-inclusive/elf (launch, swap, token, max-wallet ELFs)
#   HOOKLAB_NATIVE_ELF_DIR                   $HOOKS_LOCAL_STATE/native-e357fdf (the reviewed native-SOL launch and swap ELFs,
#                                            hook-lab feat/native-sol e357fdf, with the unchanged token and max-wallet ELFs)
#   HOOKLAB_CANARY_PYTHONPATH                $HOOKS_LOCAL_STATE/atomic-canary-20261018/python-0.29.0 (solders 0.29.0)
#   HOOKLAB_CANARY_PYTHON                    python3 (3.10+)
#   SBF_OUT_DIR                              the three hash-pinned frozen production ELFs for the curve runtime test
#                                            (default: the recovered producer artifact under ../Gitfun/.amp/in/artifacts)
#   HOOKLAB_CURVE_RUNTIME_BINARY             no default: repoing_curve_runtime built from frozen Hook Lab
#   HOOKLAB_CURVE_PARITY_BINARY              no default: repoing_curve_parity built from frozen Hook Lab
#                                            (both: docs/HOOK_LAB_CURVE_CANDIDATE.md)
# PostgreSQL: the *-db hook tests are pinned to 127.0.0.1:55432 (user postgres, password launchtest) and create and
# drop their own scratch databases; the check stops before running anything when that server is unreachable.
#   HOOKS_RELEASE_CONCURRENCY                1
#   HOOKS_RELEASE_REPORT_DIR                 a new temporary directory (spec log and TAP report)
set -euo pipefail
cd "$(dirname "$0")/.."

state="${HOOKS_LOCAL_STATE:-$HOME/Documents/ChatGPT/hooks-local-state}"
export HOOKLAB_GENERATED_FIXTURE_DIR="${HOOKLAB_GENERATED_FIXTURE_DIR:-$state/historical-fixture-recovery-8aedbb40/fixtures}"
export HOOKLAB_INCLUSIVE_GENERATED_FIXTURE_DIR="${HOOKLAB_INCLUSIVE_GENERATED_FIXTURE_DIR:-$state/rebuilt-inclusive/evidence}"
export HOOKLAB_INCLUSIVE_TOKEN_ELF="${HOOKLAB_INCLUSIVE_TOKEN_ELF:-$state/rebuilt-inclusive/elf/bordrless_token.so}"
export HOOKLAB_CANARY_ELF_DIR="${HOOKLAB_CANARY_ELF_DIR:-$state/rebuilt-inclusive/elf}"
export HOOKLAB_NATIVE_ELF_DIR="${HOOKLAB_NATIVE_ELF_DIR:-$state/native-e357fdf}"
export HOOKLAB_CANARY_PYTHONPATH="${HOOKLAB_CANARY_PYTHONPATH:-$state/atomic-canary-20261018/python-0.29.0}"
export HOOKLAB_CANARY_PYTHON="${HOOKLAB_CANARY_PYTHON:-python3}"
export HOOKLAB_CANARY_REQUIRED=true
export SBF_OUT_DIR="${SBF_OUT_DIR:-$(dirname "$state")/Gitfun/.amp/in/artifacts/hooklab-recovery-20261016/producer/production}"
database_url=postgres://postgres:launchtest@127.0.0.1:55432/postgres
# Hook DB tests pin their own local server; never let an ambient application database or RPC endpoint leak in.
for name in $(env | sed -n 's/^\([A-Za-z0-9_]*DATABASE_URL\)=.*/\1/p'); do unset "$name"; done
unset SOLANA_RPC_URL

if [ "$#" -gt 0 ]; then
  HOOK_TESTS=("$@")
else
  shopt -s nullglob
  HOOK_TESTS=(tests/hooklab-*.test.mjs tests/hooks-*.test.mjs tests/hook-*.test.mjs tests/programmable-coins-page.test.mjs)
fi

missing=0
check() { # check <label> <path> <test-flag>
  if [ -n "$2" ] && [ "$3" "$2" ]; then printf '  ok       %-40s %s\n' "$1" "$2"
  else printf '  MISSING  %-40s %s\n' "$1" "${2:-(unset)}"; missing=$((missing + 1)); fi
}
echo "hooks release check: ${#HOOK_TESTS[@]} test files"
echo "private artifacts:"
check HOOKLAB_GENERATED_FIXTURE_DIR "$HOOKLAB_GENERATED_FIXTURE_DIR" -d
for name in hooklab-max-wallet-rust-vector.json hooklab-max-wallet-buy-rust-vector.json hooklab-max-wallet-sell-rust-vector.json \
  buy-app-plan.json sell-app-plan.json hooklab-custom-rust-vector.json hooklab-custom-launch-rust-vector.json; do
  check "  $name" "$HOOKLAB_GENERATED_FIXTURE_DIR/$name" -f
done
check HOOKLAB_INCLUSIVE_GENERATED_FIXTURE_DIR "$HOOKLAB_INCLUSIVE_GENERATED_FIXTURE_DIR" -d
for name in inclusive-builder-vector.json inclusive-post-launch-snapshot.json; do
  check "  $name" "$HOOKLAB_INCLUSIVE_GENERATED_FIXTURE_DIR/$name" -f
done
check HOOKLAB_INCLUSIVE_TOKEN_ELF "$HOOKLAB_INCLUSIVE_TOKEN_ELF" -f
for name in bordrless_launch bordrless_swap bordrless_token hook_max_wallet; do
  check "  HOOKLAB_CANARY_ELF_DIR/$name.so" "$HOOKLAB_CANARY_ELF_DIR/$name.so" -f
done
for name in bordrless_launch bordrless_swap bordrless_token hook_max_wallet; do
  check "  HOOKLAB_NATIVE_ELF_DIR/$name.so" "$HOOKLAB_NATIVE_ELF_DIR/$name.so" -f
done
check HOOKLAB_CANARY_PYTHONPATH "$HOOKLAB_CANARY_PYTHONPATH" -d
if ! PYTHONPATH="$HOOKLAB_CANARY_PYTHONPATH" PYTHONNOUSERSITE=1 PYTHONDONTWRITEBYTECODE=1 "$HOOKLAB_CANARY_PYTHON" -c \
  'import solders; assert solders.__version__ == "0.29.0"' 2>/dev/null; then
  echo "  MISSING  solders 0.29.0 importable by $HOOKLAB_CANARY_PYTHON from HOOKLAB_CANARY_PYTHONPATH"; missing=$((missing + 1))
fi
for name in bordrless_launch bordrless_swap bordrless_token; do
  check "  SBF_OUT_DIR/$name.so" "$SBF_OUT_DIR/$name.so" -f
done
check HOOKLAB_CURVE_RUNTIME_BINARY "${HOOKLAB_CURVE_RUNTIME_BINARY:-}" -x
check HOOKLAB_CURVE_PARITY_BINARY "${HOOKLAB_CURVE_PARITY_BINARY:-}" -x
if [ "$missing" -gt 0 ]; then
  echo "  $missing artifact(s) missing: the tests that need them will skip and this check will fail"
fi

# Fail fast: every *-db hook test connects to exactly this server.
if ! node --input-type=module -e '
  import pg from "pg"
  const client = new pg.Client({ connectionString: process.argv[1], connectionTimeoutMillis: 5000 })
  try { await client.connect(); await client.query("select 1"); await client.end() }
  catch (error) { console.error(`  ${error.code ?? ""} ${error.message}`); process.exit(1) }
' "$database_url"; then
  echo "hooks release check: PostgreSQL is unreachable at 127.0.0.1:55432 (user postgres, password launchtest)." >&2
  echo "  Start the local test server there and rerun; the hook *-db tests are pinned to it." >&2
  exit 2
fi

report_dir="${HOOKS_RELEASE_REPORT_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/hooks-release-check.XXXXXX")}"
mkdir -p "$report_dir"
tap="$report_dir/hooks-release.tap"
spec="$report_dir/hooks-release.spec.log"
echo "running node --test (concurrency ${HOOKS_RELEASE_CONCURRENCY:-1}; one dot per test); spec log: $spec"
status=0
node --test --test-concurrency="${HOOKS_RELEASE_CONCURRENCY:-1}" \
  --test-reporter=dot --test-reporter-destination=stdout \
  --test-reporter=spec --test-reporter-destination="$spec" \
  --test-reporter=tap --test-reporter-destination="$tap" \
  "${HOOK_TESTS[@]}" || status=$?

node --input-type=module -e '
  import { readFileSync } from "node:fs"
  import { ARTIFACT_SKIP_PREFIX as prefix } from "./tests/fixtures/hooklab-generated-artifact.mjs"
  const [tap, status] = process.argv.slice(1)
  const lines = readFileSync(tap, "utf8").split("\n")
  const totals = {}, skips = new Map(), failures = []
  let diagnostics = []
  for (const [index, line] of lines.entries()) {
    // A file that fails before its tests run reports only "test failed"; keep its stderr (# lines) as the cause.
    if (/^# (?!Subtest: )/.test(line)) diagnostics.push(line.slice(2).trim())
    const total = /^# (tests|pass|fail|cancelled|skipped|todo) (\d+)$/.exec(line)
    if (total) totals[total[1]] = Number(total[2])
    const skip = /^\s*ok \d+ - (.*?) # SKIP ?(.*)$/.exec(line)
    if (skip) skips.set(skip[2] || "(no reason given)", [...(skips.get(skip[2] || "(no reason given)") ?? []), skip[1]])
    const failed = /^(\s*)not ok \d+ - (.*)$/.exec(line)
    if (failed) {
      const block = []
      for (let next = index + 1; next < lines.length && !/^\s*\.\.\.$/.test(lines[next]); next++) block.push(lines[next].trim())
      const field = name => { // a YAML block scalar (|- or >-) carries its text on the following lines
        const at = block.findIndex(entry => entry.startsWith(`${name}:`)), value = at < 0 ? undefined : block[at].slice(name.length + 1).trim()
        return /^[|>]/.test(value ?? "") ? block.slice(at + 1).find(Boolean) : value
      }
      const cause = failed[1].length ? undefined : diagnostics.find(entry => /Error/.test(entry))
      failures.push({ name: failed[2], location: field("location"), error: cause ?? field("error") })
    }
    if (/^(not )?ok \d+ - /.test(line)) diagnostics = []
  }
  console.log("\n=== hooks release check summary")
  console.log(["tests", "pass", "fail", "cancelled", "skipped", "todo"].map(key => `${key} ${totals[key] ?? 0}`).join(", "))
  for (const failure of failures) console.log(`FAIL ${failure.name}\n     ${failure.location ?? ""}\n     ${failure.error ?? ""}`)
  let artifactSkips = 0
  if (skips.size) console.log("skip reasons:")
  for (const [reason, names] of skips) {
    const artifact = reason.startsWith(prefix)
    if (artifact) artifactSkips += names.length
    console.log(`  ${artifact ? "MISSING ARTIFACT " : ""}${names.length} x ${reason}`)
    for (const name of names.slice(0, 3)) console.log(`      - ${name}`)
    if (names.length > 3) console.log(`      - ... ${names.length - 3} more`)
  }
  const ok = Number(status) === 0 && !failures.length && !totals.fail && !totals.cancelled && artifactSkips === 0
  console.log(ok ? "RESULT: PASS" : `RESULT: FAIL (exit ${status}, ${failures.length} failing entries, ${artifactSkips} missing-artifact skips)`)
  process.exit(ok ? 0 : 1)
' "$tap" "$status"
