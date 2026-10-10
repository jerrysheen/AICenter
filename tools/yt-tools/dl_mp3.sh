#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 || -z "${1:-}" ]]; then
  echo "用法: ./dl_mp3.sh <视频链接>" >&2
  exit 1
fi

URL="$1"
ROOT="${YT_TOOLS_HOME:-$HOME/yt-tools}"
OUT="$ROOT/output"
mkdir -p "$OUT"

# Git Bash would otherwise turn /c/Users into C:\c\Users when calling Windows programs.
to_native() {
  if command -v cygpath >/dev/null 2>&1; then
    cygpath -w "$1"
  else
    printf '%s\n' "$1"
  fi
}
export MSYS_NO_PATHCONV=1
OUT_NATIVE="$(to_native "$OUT")"

if [[ -x "$ROOT/venv/Scripts/yt-dlp.exe" ]]; then
  YTDLP="$(to_native "$ROOT/venv/Scripts/yt-dlp.exe")"
elif [[ -x "$ROOT/venv/bin/yt-dlp" ]]; then
  YTDLP="$ROOT/venv/bin/yt-dlp"
else
  echo "未找到 yt-dlp，请先在 $ROOT/venv 安装" >&2
  exit 1
fi

echo "可用字幕:"
SUBS="$("$YTDLP" --force-ipv4 --no-playlist --js-runtimes deno --list-subs "$URL" 2>&1 || true)"
printf '%s\n' "$SUBS"

ARGS=(
  --force-ipv4
  --no-playlist
  --js-runtimes deno
  -f "140/251/bestaudio"
  -x
  --audio-format mp3
  --audio-quality 0
  -o "$OUT_NATIVE/%(title)s [%(id)s].%(ext)s"
  --print "after_move:filepath"
)
LANGS="$(printf '%s\n' "$SUBS" | awk '
  /^Language / { next }
  /Available automatic captions/ { section = "auto"; next }
  /Available subtitles/ { section = "sub"; next }
  /^\[/ { section = ""; next }
  section && $1 ~ /^[A-Za-z][A-Za-z0-9-]*$/ && $0 !~ / from / { print $1 }
' | sort -u | paste -sd, -)"
if [[ -n "$LANGS" ]]; then
  ARGS+=(--write-subs --write-auto-subs --convert-subs srt --sub-langs "$LANGS" --extractor-args "youtube:skip=translated_subs")
fi

FILE="$("$YTDLP" "${ARGS[@]}" "$URL" | tail -n 1)"
if [[ ! -f "$FILE" ]]; then
  echo "下载异常，可能拿到的是错误网页" >&2
  exit 1
fi

if ! PROBE="$(ffprobe -v error -show_entries format=duration,size -of default=noprint_wrappers=1:nokey=0 "$FILE")"; then
  echo "下载异常，可能拿到的是错误网页" >&2
  exit 1
fi

SIZE="$(printf '%s\n' "$PROBE" | sed -n 's/^size=//p' | tail -n 1)"
DURATION="$(printf '%s\n' "$PROBE" | sed -n 's/^duration=//p' | tail -n 1)"
if [[ -z "$SIZE" || -z "$DURATION" || "$SIZE" -lt 1048576 ]]; then
  echo "下载异常，可能拿到的是错误网页" >&2
  echo "时长: ${DURATION:-未知}  大小: ${SIZE:-未知} 字节" >&2
  exit 1
fi

echo "文件: $FILE"
echo "时长: ${DURATION} 秒"
echo "大小: ${SIZE} 字节"
