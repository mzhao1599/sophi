#!/usr/bin/env bash
# Installs what the walker's fall check needs (README, "Fall check"): the pose model and onnxruntime-node, beside
# walker.mjs in /opt/steady-walker. Written 2026-10-25; not yet run on the Pi.
# Usage, on the Pi, after install-pi.sh: sudo ./scripts/install-fall-check.sh
# What it does:
# - downloads MoveNet SinglePose Lightning (ONNX, Apache-2.0) from Hugging Face at a pinned revision to
#   /opt/steady-walker/models/movenet-singlepose-lightning.onnx, and refuses it unless its SHA-256 matches;
# - installs onnxruntime-node at a pinned version into /opt/steady-walker/node_modules, where walker.mjs finds it
#   (it is a native module, so it can't be bundled into walker.mjs; about 300 MB on disk with every platform's
#   binaries, not measured on the Pi).
# It does not turn the fall check on: add WALKER_FALL_CHECK=on (and WALKER_CAMERA_DEVICE) to /etc/steady-walker.env,
# then sudo systemctl restart steady-walker.
set -euo pipefail

MODEL_REVISION="ed0f314bb7356fd1dbf1e4f52c2d40791bf6534f"
MODEL_URL="https://huggingface.co/Xenova/movenet-singlepose-lightning/resolve/${MODEL_REVISION}/onnx/model.onnx"
MODEL_SHA256="1ad4f8d6c2f776a9967db3993c9ca740bc350104f9d37c151dc183fc29a464ad"
ORT_VERSION="1.30.0"
prefix="${WALKER_INSTALL_DIR:-/opt/steady-walker}"
model="$prefix/models/movenet-singlepose-lightning.onnx"

if [[ $EUID -ne 0 ]]; then
  echo "Run with sudo: sudo $0" >&2
  exit 1
fi
command -v curl >/dev/null || { echo "curl is missing: sudo apt install curl" >&2; exit 1; }
command -v npm >/dev/null || { echo "npm is missing: sudo apt install npm" >&2; exit 1; }
command -v ffmpeg >/dev/null || echo "Note: ffmpeg is missing; the camera needs it. Install with: sudo apt install ffmpeg" >&2

install -d -m 0755 "$prefix/models"
if [[ -f "$model" ]] && echo "$MODEL_SHA256  $model" | sha256sum --check --status; then
  echo "Pose model already in place: $model"
else
  tmp="$(mktemp "$prefix/models/.download.XXXXXX")"
  trap 'rm -f "$tmp"' EXIT
  curl -fsSL --retry 5 --retry-all-errors -o "$tmp" "$MODEL_URL"
  if ! echo "$MODEL_SHA256  $tmp" | sha256sum --check --status; then
    echo "The downloaded pose model's SHA-256 doesn't match; nothing installed." >&2
    exit 1
  fi
  install -m 0644 "$tmp" "$model"
  echo "Pose model installed: $model"
fi

# A package.json of its own, so npm installs into $prefix/node_modules and nowhere else.
[[ -f "$prefix/package.json" ]] || echo '{ "name": "steady-walker-runtime", "private": true }' > "$prefix/package.json"
npm install --prefix "$prefix" --omit=dev --no-audit --no-fund --save-exact "onnxruntime-node@${ORT_VERSION}"
node --input-type=module -e "import { createRequire } from 'node:module'; const require = createRequire('$prefix/walker.mjs'); require('onnxruntime-node'); console.log('onnxruntime-node loads from $prefix');"
echo "Done. To turn the fall check on: add WALKER_FALL_CHECK=on to /etc/steady-walker.env (with WALKER_CAMERA_DEVICE set), then: sudo systemctl restart steady-walker"
