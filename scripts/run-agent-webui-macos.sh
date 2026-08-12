#!/bin/zsh
set -euo pipefail

script_dir="$(cd "$(dirname "$0")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"

export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export AGENT_WEBUI_HOST="${AGENT_WEBUI_HOST:-127.0.0.1}"
export AGENT_WEBUI_PORT="${AGENT_WEBUI_PORT:-3457}"

cd "$repo_root"
exec node backend/dist/server.js
