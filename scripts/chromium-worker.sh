#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
IFS= read -r node_bin < .deployment-node
exec "$node_bin" src/web-fetch-browser/chromium-worker.js
