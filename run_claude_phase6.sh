#!/bin/bash
PROJ_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJ_NAME=$(basename "$PROJ_DIR")
cd "$PROJ_DIR" || exit 1
mkdir -p logs
LOOP_COUNT=0
MAX_LOOPS=200
while [ $LOOP_COUNT -lt $MAX_LOOPS ]; do
  LOOP_COUNT=$((LOOP_COUNT + 1))
  REM=$(grep -c "^- \[ \]" TODO_PHASE6.md 2>/dev/null | head -1)
  REM=${REM:-0}
  if [ "$REM" -le 0 ]; then
    echo "[$PROJ_NAME phase6] 完了" | tee -a logs/claude_phase6.log
    break
  fi
  echo "[$(date '+%H:%M:%S')] [$PROJ_NAME phase6 L$LOOP_COUNT] 残$REM" | tee -a logs/claude_phase6.log

  PROMPT="$PROJ_NAME (Chrome 拡張 MV3、Phase 5 完成済、Chrome Web Store 申請準備済) の Phase 6 品質向上タスクを実装。

【絶対遵守】
- TODO_PHASE6.md の最初の [ ] を 1 つだけ完了
- TODO.md (Phase 1-5) は触らない (完成済)
- release/*.zip は触らない (申請準備済)
- manifest.json の version は変更しない (1.0.0 のまま)
- 既存の機能仕様を壊さない (ユーザー設定の互換性維持)
- npm install はしない (依存追加は package.json 編集のみ、commit msg に '[needs install]' 明記)

【手順】
1. TODO_PHASE6.md 先頭の [ ] を確認
2. 該当タスクを実装 (1タスクのみ)
3. TODO_PHASE6.md の該当行を [x] に変更
4. git add -A
5. git commit -m 'T1xx phase6: <summary>'
6. git push origin main
7. exit

【絶対禁止】
- ユーザーへの質問
- Plan Mode の提案
- 詰まったら 30 秒以内にスキップ ([SKIP: 理由] を末尾追記)

1 タスクのみ実装して終了。"

  gtimeout 900 claude --print --dangerously-skip-permissions "$PROMPT" 2>&1 | tee -a logs/claude_phase6.log
  RC=${PIPESTATUS[0]}
  [ "$RC" -ne 0 ] && sleep 180 || sleep 8
done
