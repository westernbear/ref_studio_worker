#!/bin/sh
set -eu
if [ "$#" -ne 2 ] || [ "$1" != "pnpm" ] || [ "$2" != "render:smoke" ]; then
  printf '%s\n' 'offline worker accepts only pnpm render:smoke' >&2
  exit 64
fi
exec node /workspace/apps/worker/src/capture/smoke-runner.mjs
