#!/bin/bash
PROJ_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$PROJ_DIR" || exit 1
mkdir -p logs

LOOP_COUNT=0
MAX_LOOPS=200

while [ $LOOP_COUNT -lt $MAX_LOOPS ]; do
  LOOP_COUNT=$((LOOP_COUNT + 1))
  REM=$(grep -c "^- \[ \]" TODO.md 2>/dev/null | head -1)
  REM=${REM:-0}

  if [ "$REM" -le 0 ]; then
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] TODO 全消化、ループ終了。"
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] === COMPLETED ===" >> logs/gemini_$(date +%Y%m%d).log
    break
  fi

  PROJ_NAME=$(basename "$PROJ_DIR")
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] [$PROJ_NAME Loop $LOOP_COUNT] 残 $REM タスク..." | tee -a logs/gemini_$(date +%Y%m%d).log

  timeout 600 gemini -p "Read SPEC.md and TODO.md. Pick the FIRST unchecked TODO (line starting with '- [ ]'). Implement only ONE task. After implementing, update TODO.md to mark [x] for that task. Then git commit with message 'T<id>: <task summary>'. Stack: Manifest V3, TypeScript+Vite, chrome.storage.local, chrome.i18n. No external API (except where explicitly stated in SPEC.md), no personal data collection, ads-free, minimum permissions. Do ONE task only this run. If git is not initialized, run 'git init && git add -A && git commit -m \"chore: initial\"' first." 2>&1 | tee -a logs/gemini_$(date +%Y%m%d).log
  RC=${PIPESTATUS[0]}

  if [ "$RC" -ne 0 ]; then
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] Gemini エラー (RC=$RC)、6分待機..." | tee -a logs/gemini_$(date +%Y%m%d).log
    sleep 360
  else
    sleep 12
  fi
done
