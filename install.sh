#!/usr/bin/env bash
# Install paper-modes for this user session.
set -euo pipefail
ROOT="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
exec "$ROOT/mode.sh" install
