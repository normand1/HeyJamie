#!/usr/bin/env bash
set -euo pipefail

EXCALIDRAW_DIR="$HOME/mcp_excalidraw"

if [ ! -d "$EXCALIDRAW_DIR/.git" ]; then
  git clone --depth 1 https://github.com/yctimlin/mcp_excalidraw.git "$EXCALIDRAW_DIR"
else
  git -C "$EXCALIDRAW_DIR" pull --ff-only
fi

cd "$EXCALIDRAW_DIR"

npm install
npm run build

echo ""
echo "mcp_excalidraw ready."
echo "Dir: $EXCALIDRAW_DIR"
