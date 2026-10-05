#!/usr/bin/env bash
# Prepare a pinned official DSH checkout for source-composition tests.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
TARGET="${DSH_UPSTREAM:-$ROOT/.tools/dsh-upstream}"
COMMIT=5badb15009ae1756c3afe0ae0cef1faafc290ccc
CACHE="$ROOT/.tools/dsh-cache"
mkdir -p "$CACHE"
if [[ ! -d "$TARGET/.git" ]]; then
  mkdir -p "$TARGET"
  git -C "$TARGET" init
  git -C "$TARGET" remote add origin https://github.com/deepseek-ai/deepseek-harness.git
  git -C "$TARGET" fetch --depth 1 origin "$COMMIT"
  git -C "$TARGET" checkout --detach FETCH_HEAD
fi
[[ "$(git -C "$TARGET" rev-parse HEAD)" == "$COMMIT" ]] || { echo 'BLOCKED: DSH checkout differs from pinned commit; use a separate DSH_UPSTREAM directory' >&2; exit 1; }
cd "$TARGET"
# No upstream lifecycle scripts are needed by this source-only integration.
XDG_CACHE_HOME="$CACHE" pnpm install --frozen-lockfile --ignore-scripts --store-dir "$CACHE/pnpm-store"
case "$(uname -s)-$(uname -m)" in
  Linux-x86_64)
    # Same official native package version as the pinned checkout; avoids local
    # Node development-header/musl compiler prerequisites. No source patch.
    mkdir -p "$CACHE/native"
    npm pack @deepseek-ai/node-addon-system-linux-x64@0.1.2 --ignore-scripts --cache "$CACHE/npm" --pack-destination "$CACHE/native"
    tar -xzf "$CACHE/native/deepseek-ai-node-addon-system-linux-x64-0.1.2.tgz" --directory native/system/packages/linux-x64 --strip-components=1 package/bin
    ;;
  *)
    node --import tsx native/system/scripts/build.ts --host-addon-only
    ;;
esac
printf '\nPrepared DSH_UPSTREAM=%s\n' "$TARGET"
