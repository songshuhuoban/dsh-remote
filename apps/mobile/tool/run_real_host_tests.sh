#!/usr/bin/env bash
# Requires the pinned real DSH source fixture prepared by the repository's
# bootstrap-upstream script. The only scripted service is the external model.
set -euo pipefail
cd "$(dirname "$0")/.."
mobile="$PWD"
root="$(cd ../.. && pwd)"
mkdir -p .tools/test-data
export CI=true BOT=true
bun run --cwd "$root/packages/dsh-plugin" build
LIVE_PROVIDER_E2E=0 DSH_E2E_KEEP_RUNNING=1 DSH_E2E_PORT="${DSH_E2E_PORT:-3108}" bun "$root/packages/dsh-plugin/tests/runtime-smoke.ts" >.tools/test-data/runtime.log 2>&1 &
fixture=$!
trap 'kill "$fixture" 2>/dev/null || true; wait "$fixture" 2>/dev/null || true' EXIT
for i in $(seq 1 90); do
  if grep -q '^FIXTURE_READY ' .tools/test-data/runtime.log; then break; fi
  if ! kill -0 "$fixture" 2>/dev/null; then cat .tools/test-data/runtime.log; exit 1; fi
  sleep 1
done
python3 - <<'PY'
from pathlib import Path
lines=Path('.tools/test-data/runtime.log').read_text().splitlines()
ready=next(line for line in lines if line.startswith('FIXTURE_READY '))
Path('.tools/test-data/fixture.json').write_text(ready.removeprefix('FIXTURE_READY '))
PY
export DSH_FIXTURE_PATH="$mobile/.tools/test-data/fixture.json"
set +e
if [[ -f .tools/flutter-tool.dill ]]; then
  .tools/flutter/bin/cache/dart-sdk/bin/dart .tools/flutter-tool.dill --no-version-check test test/real_host_test.dart --dart-define=HISTORY_PAGE_SIZE=1 --reporter expanded >.tools/test-data/flutter-integration.log 2>&1
else
  flutter test test/real_host_test.dart --dart-define=HISTORY_PAGE_SIZE=1 --reporter expanded >.tools/test-data/flutter-integration.log 2>&1
fi
status=$?
cat .tools/test-data/flutter-integration.log
exit "$status"
