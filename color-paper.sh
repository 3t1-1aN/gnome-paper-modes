#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
# shellcheck disable=SC1091
source "$ROOT/lib.sh"
paper_apply color-paper
