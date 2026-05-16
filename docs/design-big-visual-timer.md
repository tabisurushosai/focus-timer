# Design: big-visual-timer

ADHD/ASD ユーザーが「あと何分か」を一目で把握できる、大きな視覚タイマー。
ポモドーロのフェーズ (work / break / long_break) を円形プログレスと数字で同時に表示する。

## 目的 / 非目的

- 目的
  - 1 ポップアップ画面の主役を「残り時間の視覚化」にすること。
  - フェーズの種類が瞬時に分かること (色 + ラベル)。
  - service worker がアンロードされても残り時間が正確に再開できること。
  - 視覚過敏に配慮: 過剰なアニメーションなし、`prefers-reduced-motion` 尊重。
- 非目的
  - 高解像度の音/アニメーションエフェクト (sound-mute / child-mode 側の責務)。
  - 詳細統計の表示 (session-stats 側の責務)。
  - 通知本体 (break-reminder 側の責務)。

## ユーザー要件

| 要件 | 実装上の要件 |
| --- | --- |
| 「あと N 分」が直感的に分かる | 円形プログレス + mm:ss の数字を併記 |
| 集中/休憩のフェーズが分かる | `mode-label` + プログレスの色をフェーズで変える |
| ポップアップを閉じても進行する | タイマー状態は `chrome.storage.local.timer` を真実とする |
| 拡張機能を再起動しても継続 | `end_ts` (絶対時刻) を保存し再計算 |
| 視覚過敏 | `prefers-reduced-motion: reduce` で進捗アニメ無効化 |

## 状態モデル

`src/storage.ts` の `TimerState` を真実とする (既存スキーマを再利用):

```ts
type TimerState = {
  mode: "work" | "break" | "long_break";
  running: boolean;
  end_ts: number;       // 絶対 epoch ms。実行中だけ意味を持つ
  remaining_ms: number; // pause 時の残り。再開時に end_ts へ展開
  session_count: number;
};
```

- 不変条件
  - `running === true` のとき `end_ts > 0` を保証する。
  - `running === false` のとき `remaining_ms >= 0` を保証する。
  - フェーズ遷移直後は `running=false, remaining_ms=totalForMode(mode)`。
- フェーズあたりの総時間は `Settings.work_min / break_min / long_break_min` から導出する。`TimerState` には冗長に持たない。

## モジュール責務

| モジュール | 責務 |
| --- | --- |
| `src/background.ts` (service_worker) | 真実のタイマー。`chrome.alarms` で end_ts に発火し、フェーズを遷移させる。`chrome.runtime.onMessage` で `timer_start / pause / resume / reset / skip` を受ける。 |
| `src/popup.ts` | 画面表示。`chrome.storage.local` を購読し、SVG リングと数字を 250ms 間隔で再描画。`running` の間だけ tick。 |
| `src/popup.html` | SVG リング (`circle r=92`) + `time-left` + `mode-label`。aria-live は `polite`。 |
| `src/popup.css` | フェーズごとのアクセントカラー、`prefers-reduced-motion` 対応。 |
| `src/storage.ts` | 型・既定値・購読 API。state mutation はここを経由 (popup/options) または background が直接書く。 |

## メッセージ契約 (popup → background)

`chrome.runtime.sendMessage`:

```
{ type: "timer_start" }         // mode は現在の TimerState.mode に従う
{ type: "timer_pause" }
{ type: "timer_resume" }
{ type: "timer_reset" }         // 同フェーズの満タンに戻す。session_count は維持
{ type: "timer_skip" }          // 次フェーズに進める。session_count を更新
```

返り値は `{ ok: boolean }`。状態取得は不要 (popup は `chrome.storage.local` を直接購読)。

## ライフサイクル

1. `onInstalled` / `onStartup`: `storage.ensureDefaults()` を呼ぶ。`running=false` で起動する。
2. `timer_start` 受信: `end_ts = now + remaining_ms`、`running=true`、`chrome.alarms.create(ALARM_PHASE_END, { when: end_ts })`。
3. アラーム発火: `mode` を遷移、`session_count` 更新、`auto_start_*` に従い続行 or 停止。
4. `timer_pause`: アラーム解除、`remaining_ms = max(0, end_ts - now)`、`running=false`。
5. `timer_resume`: `timer_start` と同じ手順 (端数を `remaining_ms` から復元)。
6. `timer_reset`: `remaining_ms = totalForMode(mode)`、`running=false`、アラーム解除。
7. `timer_skip`: `mode` を遷移して `remaining_ms = totalForMode(next)`、`running=false`、アラーム解除。

絶対時刻 (`end_ts`) を真実とすることで service worker のアンロード/復活、Chrome 再起動、OS sleep を跨いでもドリフトしない。

## 視覚仕様

- SVG: `viewBox 200x200`, 進捗円 `r=92`、`stroke-width=12`、`stroke-linecap=round`。
- 円周 = `2π·92 ≒ 578` → `stroke-dasharray=578` 固定, `stroke-dashoffset` を `0..578` で動かす。
  進捗 = `remaining / total`、`offset = 578 * (1 - clamp(progress, 0, 1))`。
- 進捗の塗りは `rotate(-90)` で 12 時方向開始。
- ラベル: `data-i18n="popup_mode_work"` 等。
- mm:ss 表示は monospace 風 (`tabular-nums`)、横揺れ防止。
- フェーズカラー (CSS カスタムプロパティ):
  - `--timer-progress-work` (集中: 落ち着いた寒色)
  - `--timer-progress-break` (休憩: 緑系)
  - `--timer-progress-long-break` (長休憩: 紫系)
  - child-mode 時は彩度を上げる ([[design-child-mode]] と整合)。

## アクセシビリティ

- ルートに `role="timer"` + `aria-live="polite"`。
- 残り時間は `aria-live="polite"` で頻繁更新を避けるため秒未満で再アナウンスしない。
- 円グラフ自体は `aria-hidden="true"` (装飾)。情報は数字側で読み上げ。
- フォーカス可視: `:focus-visible` で 2px のリング、`prefers-contrast: more` で 3px。
- `prefers-reduced-motion: reduce` 時は `stroke-dashoffset` の CSS transition を無効化し、即時更新。

## ティック戦略

- 真実は `end_ts`。popup は `running` の間だけ 250ms 間隔で `requestAnimationFrame` ベースの軽量再描画。
- 250ms にしているのは秒境界を確実に拾い、かつ CPU を増やしすぎないため。
- popup を閉じた間は描画も停止。再オープン時に `currentRemainingMs()` で再計算する。
- 残り 0 になったら popup 側のタイマーは止めて background のアラーム発火を待つ (ダブルカウントしない)。

## エッジケース

| ケース | 振る舞い |
| --- | --- |
| 端末スリープから復帰 | `end_ts` が過去 → 復帰直後に `phase_end` アラームが即発火し遷移。popup は 0 表示後すぐ次フェーズへ。 |
| OS 時計が逆行 | 1 周期で表示が異常になり得るが、ユーザー操作 (reset/skip) で復旧。許容。 |
| 設定変更で `work_min` を増減 | 進行中の `end_ts` は不変。次フェーズから反映。reset すれば現フェーズも反映。 |
| Premium 解放/解除 | 視覚タイマー自体は無料機能。Premium 影響なし。 |
| ストレージ未初期化 | popup は `loadAndRender()` で早期 return し、`ensureDefaults()` 後の `onChanged` で再描画。 |

## 関連メモ

- [[design-child-mode]]: 色テーマ・大きさを変える。
- [[design-session-stats]]: `session_count` 更新ポイントを共有する。
- [[design-break-reminder]]: フェーズ遷移時の通知/アラームを担当。
- [[design-sound-mute]]: フェーズ遷移時の音をミュート設定で抑制。

## 受け入れ条件 (T017/T018 で検証)

- `running=true` のとき残り時間が秒単位で減り、リングが対応して縮む。
- ポップアップを閉じて 10 秒後に開くと、表示が 10 秒進んでいる。
- service worker を再起動しても `end_ts` から復元され、同じ残り時間が表示される。
- `prefers-reduced-motion: reduce` でリングが滑らかではなく階段状に更新される。
- `mode` 変更でアクセントカラーが切り替わる。
- popup_mode_* / popup_time_left / popup_session_count が ja/en 両方で表示できる。
