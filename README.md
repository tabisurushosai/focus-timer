# 集中タイマー (focus-timer)

ADHD/ASD 向けポモドーロタイマー Chrome 拡張機能 (MV3)。視覚タイマー、子供モード、Premium 機能を備えた集中サポートツール。

A Pomodoro timer Chrome extension (MV3) for ADHD/ASD users. Visual timer, kids mode, and Premium features to support deep focus.

---

## 機能一覧 / Features

### 基本機能 / Core
- **ポモドーロサイクル / Pomodoro cycle**: 25 分作業 + 5 分休憩 (時間は変更可) / 25 min work + 5 min break (configurable)
- **視覚タイマー / Visual timer**: 残り時間を円グラフで可視化 / Circular progress arc for remaining time
- **通知音 / Notification sound**: 終了時に音を再生 (offscreen API、音量調節可) / Plays a sound at session end (offscreen API, volume adjustable)
- **デスクトップ通知 / Desktop notification**: chrome.notifications でセッション完了を通知 / `chrome.notifications` on completion
- **日次サイクル数記録 / Daily cycle count**: その日完了したサイクル数を保存 / Stores today's completed cycles
- **完全オフライン / Fully offline**: chrome.storage.local のみ使用、外部送信なし / All state in `chrome.storage.local`, no external traffic

### Premium 機能 / Premium
- **30 / 90 日チャート**: 中期の集中傾向を可視化 / Mid-range focus trend chart
- **累計集中時間 / Lifetime focus minutes**: 全期間の累計を表示 / Lifetime total
- **CSV エクスポート / CSV export**: 統計データをダウンロード / Download session stats as CSV
- **子供モード / Kids mode**: シンプル UI + 大きなボタン / Simplified UI with larger controls
- **試用 / Trial**: インストール後 7 日間 Premium 機能を試用可 / 7-day Premium trial after install

### 多言語 / i18n
- 日本語 (デフォルト) / Japanese (default)
- English

---

## 使用例 / Usage

### 基本的な使い方 / Basic flow

1. ツールバーの拡張機能アイコンをクリックしてポップアップを開く / Click the toolbar icon to open the popup
2. **▶ Start** を押すと 25 分の作業セッションが開始 / Press **▶ Start** to begin a 25 min work session
3. 終了時に通知 + 音、自動で 5 分休憩が開始 / Notification + sound at the end, 5 min break starts automatically
4. **⏸ Pause / ⏭ Skip / ⏹ Reset** で制御 / Control via **⏸ Pause / ⏭ Skip / ⏹ Reset**

### 設定変更 / Changing settings

1. 拡張機能アイコンを右クリック → **オプション** / Right-click the icon → **Options**
2. 作業 / 休憩時間、通知音、音量、子供モードを変更 / Adjust work / break minutes, sound, volume, and kids mode
3. 変更は即座に保存 (chrome.storage.local) / Saved instantly to `chrome.storage.local`

### Premium へのアップグレード / Upgrading to Premium

1. オプション画面の **Premium** セクションを開く / Open the **Premium** section in Options
2. **Upgrade** ボタンから Stripe Checkout へ遷移 / Click **Upgrade** to launch Stripe Checkout
3. 購入後、ライセンスキーを入力して unlock / Enter the license key after purchase to unlock

---

## 開発 / Development

```bash
npm install           # 依存インストール / install deps
npm run lint          # tsc --noEmit
npm test              # vitest
npm run build         # vite build → dist/
npm run package       # build + release/focus-timer.zip
```

Chrome で `chrome://extensions` → **デベロッパーモード** → **パッケージ化されていない拡張機能を読み込む** で `dist/` を選択 / In Chrome, open `chrome://extensions`, enable **Developer mode**, and **Load unpacked** from `dist/`.

---

## ストア / Store

Chrome Web Store (申請準備済 / submission-ready)

## ライセンス / License

詳細は `legal/` ディレクトリ参照 / See the `legal/` directory.
