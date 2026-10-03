#!/usr/bin/env bash
# Remove the ACP Chat native messaging host registration.
set -euo pipefail
HOST_NAME="dev.acp_chat.host"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ "$(uname)" == "Darwin" ]]; then
  SEARCH="$HOME/Library/Application Support"
else
  SEARCH="${XDG_CONFIG_HOME:-$HOME/.config}"
fi

find "$SEARCH" -maxdepth 4 -path "*/NativeMessagingHosts/$HOST_NAME.json" -print -delete 2>/dev/null || true
rm -f "$ROOT/host/acp-chat-host"
echo "uninstalled $HOST_NAME"
