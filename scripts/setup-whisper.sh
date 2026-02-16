#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WHISPER_DIR="$ROOT_DIR/whisper_cpp"
MODEL="base.en"

if [ ! -d "$WHISPER_DIR/.git" ]; then
  git clone --depth 1 https://github.com/ggml-org/whisper.cpp.git "$WHISPER_DIR"
else
  git -C "$WHISPER_DIR" pull --ff-only
fi

cd "$WHISPER_DIR"

sh ./models/download-ggml-model.sh "$MODEL"

cmake -B build
cmake --build build -j

echo ""
echo "whisper.cpp ready."
echo "CLI:   $WHISPER_DIR/build/bin/whisper-cli"
echo "Model: $WHISPER_DIR/models/ggml-$MODEL.bin"
