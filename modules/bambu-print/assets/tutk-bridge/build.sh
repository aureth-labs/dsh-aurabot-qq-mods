#!/bin/sh
# build.sh —— 编译 TUTK 抓帧桥（单文件 C，只依赖系统 API）。
#
# 仓库里带的 bambu-tutk-bridge-linux-x64 用 zig 0.17.1（clang 22.1.8 / LLD 22.1.8）生成。
# 想核对或重新出这个文件，用同版本 zig 在仓库目录里跑：
#
#   ZIG=/path/to/zig ./build.sh --repro
#
# 没有 zig 也行：CC=gcc / CC=clang / 系统 cc 都能编，只是产物不会和仓库里那份逐字节相同
# （符号表、调试信息、build-id 都随工具链变）。功能是一样的。
set -e
cd "$(dirname "$0")"
OUT="${OUT:-bambu-tutk-bridge}"
if [ "$1" = "--repro" ]; then OUT=bambu-tutk-bridge-linux-x64; fi
if [ -n "$ZIG" ]; then
  # 和仓库产物一致的构建路径：固定 target + strip。
  # -s 去掉调试信息：不然会把构建机的绝对路径（含用户名）写进 .debug_str。
  echo "using zig: $ZIG"
  "$ZIG" cc -O2 -s -target x86_64-linux-gnu -o "$OUT" bambu-tutk-bridge.c -ldl
else
  CC="${CC:-cc}"
  if ! command -v "$CC" >/dev/null 2>&1; then
    echo "找不到 C 编译器：请设置 CC，例如 CC=gcc 或 ZIG=/path/to/zig。" >&2
    exit 1
  fi
  echo "using $CC"
  # 不用 2>/dev/null || 吞掉第一次的报错：编不过就把真实错误打出来。
  # -ldl 在 glibc 上必须；musl / macOS 没有独立 libdl，所以失败后再退回不带 -ldl 试一次。
  if ! "$CC" -O2 -s -o "$OUT" bambu-tutk-bridge.c -ldl; then
    echo "带 -ldl 链接失败，回退成不带 -ldl 再试一次（musl / macOS）" >&2
    "$CC" -O2 -s -o "$OUT" bambu-tutk-bridge.c
  fi
fi
echo "built: $(pwd)/$OUT"
