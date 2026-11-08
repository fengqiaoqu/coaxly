#!/bin/bash
# 学习搭子 · macOS 启动脚本（对应 Windows 的 启动.bat）
# 双击本文件：Terminal 里启动本地代理，窗口保持打开，关窗 = 停止代理。
# 只用 macOS 自带的 Python 3，不需要安装任何依赖。
cd "$(dirname "$0")"

if [ ! -x "proxy/mac/lb-ocr" ] || [ ! -x "proxy/mac/lb-asr" ]; then
  echo "第一次使用：先编译 macOS 本地能力（画面识字 / 语音识别）…"
  bash proxy/build-mac.sh || echo "（编译失败不影响核心功能，只是少了画面识字和语音识别）"
  echo
fi

python3 proxy/server.py
status=$?
echo
if [ $status -ne 0 ]; then
  echo "代理退出（状态码 $status）。"
fi
read -r -p "按回车键关闭窗口…" _
