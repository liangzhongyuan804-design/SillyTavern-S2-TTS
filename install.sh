#!/usr/bin/env sh
# Installs the S2 TTS extension into a SillyTavern installation.
#
# Node is the one runtime every SillyTavern already needs, so this script is
# a thin wrapper around install.mjs:
#
#   sh install.sh /path/to/SillyTavern
#
# It does three things:
#
#   1. the browser extension -> <ST>/public/scripts/extensions/third-party/st-s2-tts/
#   2. the server plugin      -> <ST>/plugins/st-s2-tts/
#   3. enables the server plugins in <ST>/config.yaml
set -eu

if [ $# -lt 1 ]; then
    echo "用法：sh install.sh <SillyTavern 目录>"
    exit 1
fi

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

if ! command -v node >/dev/null 2>&1; then
    echo "找不到 node。SillyTavern 本身就需要 Node，请先安装或在 PATH 里找到它。"
    exit 1
fi

exec node "$SCRIPT_DIR/install.mjs" --st "$1"
