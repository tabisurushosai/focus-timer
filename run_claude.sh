#!/bin/bash
PROJ_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJ_NAME=$(basename "$PROJ_DIR")
cd "$PROJ_DIR" || exit 1
mkdir -p logs

LOOP_COUNT=0
MAX_LOOPS=200

while [ $LOOP_COUNT -lt $MAX_LOOPS ]; do
  LOOP_COUNT=$((LOOP_COUNT + 1))
  REM=$(grep -c "^- \[ \]" TODO.md 2>/dev/null | head -1)
  REM=${REM:-0}

  if [ "$REM" -le 0 ]; then
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] [$PROJ_NAME] TODO 全消化、ループ終了。" | tee -a logs/claude_$(date +%Y%m%d).log
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] === COMPLETED ===" >> logs/claude_$(date +%Y%m%d).log
    break
  fi

  echo "[$(date '+%Y-%m-%d %H:%M:%S')] [$PROJ_NAME Loop $LOOP_COUNT] 残 $REM タスク..." | tee -a logs/claude_$(date +%Y%m%d).log

  PROMPT="あなたは $PROJ_NAME プロジェクトの完全自律開発エージェントです。

【最重要原則】
- 絶対にユーザーに質問しない。全部自分で判断して実装する。
- 詰まったら30秒以内にスキップして次へ。完璧主義で止まるな。
- 迷ったらSPEC.mdの方針に従い、それでも迷ったら一般的なベストプラクティス。

【絶対禁止】
- このディレクトリ外への書き込み・削除
- rm -rf / cd .. による他ディレクトリ操作
- git push / git remote 関連
- ネットワーク経由のファイル送信
- 外部API呼び出し(課金リスク)
- システム設定変更

【許可】
- このディレクトリ内のファイル全部
- npm install (プロジェクトローカル)
- ローカル git commit
- リファクタ・命名変更 (自己責任)

【手順】
1. SPEC.md で仕様確認
2. TODO.md の最初の '- [ ]' を1つ選ぶ
3. 実装する。詰まったらスキップ可。スキップは行末に ' [SKIP: 理由]' を追記して '[ ]' のまま残す
4. TODO.md の該当行を '[x]' に変更 (スキップは [ ] のまま)
5. 'git add -A && git commit -m \"Txxx: <内容>\"' を実行
6. 1行で完了報告して終了

【技術スタック】
Manifest V3, TypeScript+Vite, chrome.storage.local, chrome.i18n.
No external API (SPEC.md で明記された場合除く), no personal data collection, ads-free, minimum permissions.
今回 1タスクのみ実装して終了。

【自走原則】
- ユーザーに質問しない
- 寝てる前提
- エラー3回で諦めてスキップ"

  gtimeout 900 claude --print --dangerously-skip-permissions "$PROMPT" 2>&1 | tee -a logs/claude_$(date +%Y%m%d).log
  RC=${PIPESTATUS[0]}

  if [ "$RC" -ne 0 ]; then
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] [$PROJ_NAME] Claude エラー (RC=$RC)、3分待機..." | tee -a logs/claude_$(date +%Y%m%d).log
    sleep 180
  else
    sleep 8
  fi
done
