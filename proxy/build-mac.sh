#!/bin/bash
# 编译 macOS 本地能力 CLI（画面识字 Vision + 语音识别 Speech）。
# 只需要 Xcode Command Line Tools（xcode-select --install），不需要完整 Xcode。
set -euo pipefail
cd "$(dirname "$0")"

echo "编译 lb-ocr（Vision 画面识字）…"
swiftc -O -o mac/lb-ocr mac/lb-ocr.swift 2>/dev/null || swiftc -O -o mac/lb-ocr mac/lb-ocr.swift -framework Vision -framework AppKit

echo "编译 lb-asr（Speech 语音识别）…"
swiftc -O -o mac/lb-asr mac/lb-asr.swift 2>/dev/null || swiftc -O -o mac/lb-asr mac/lb-asr.swift -framework Speech -framework Foundation

chmod +x mac/lb-ocr mac/lb-asr
echo "完成："
./mac/lb-ocr --check
./mac/lb-asr --check || true
