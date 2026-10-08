#!/usr/bin/env bash
# Launch the Agent Office orchestrator (host, no root). Extra args pass through (e.g. --once).
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p "$HOME/agent-office/workspace"
exec python3 orchestrator.py --config config.json "$@"
