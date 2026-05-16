# Design: child-mode

不登校児・発達特性児や低年齢ユーザーが、保護者の介助なしでも安全に・直感的に使える表示モード。
タイマーの仕組みは [[design-big-visual-timer]] と同じだが、外観・文字サイズ・操作面を「やさしい」プリセットに切り替える。

## 目的 / 非目的

- 目的
  - 視覚的にやさしく親しみやすい配色とフォントへ切り替える (彩度高め・柔らかいピンク/緑/紫)。
  - 文字を大きく、ボタンの当たり判定を広く取り、押し間違いを減らす。
  - 「うっかり破壊操作」を抑える: リセット/スキップは確認をワンステップ挟む。
  - 保護者が popup と options のどちらからでも切り替えられること。
  - 保存先は `Settings.child_mode`。Premium 機能ではなく、無料で常に提供する。
- 非目的
  - 別ウィンドウ・別ポップアップの導入 (1 popup 内のクラス付与で完結させる)。
  - 言語/読み上げの簡易化 (今は通常 i18n をそのまま使う)。
  - パスワード/PIN によるロック (将来検討、本タスクの範囲外)。
  - 子供向けゲーミフィケーション (報酬/シール) — 別機能 [[design-session-stats]] 範疇。

## ユーザー要件

| 要件 | 実装上の要件 |
| --- | --- |
| 子でも色・形で状態が分かる | フェーズごとの彩度を上げた配色プリセット |
| 文字が小さくて読めない | 残り時間・モードラベルのフォントサイズを増やす |
| 押し間違いで集中が中断する | リセット/スキップに `aria-describedby` 付き確認ステップ |
| 親が popup から即切り替えたい | `#toggle-child-mode` で即時保存・即時反映 |
| 切り替えを記憶 | `chrome.storage.local.settings.child_mode` に永続化 |
| 視覚過敏 | `prefers-reduced-motion` を尊重 (big-visual-timer と同じ規約) |

## 状態モデル

唯一の真実は `Settings.child_mode: boolean` ([[storage]] 参照)。

```ts
type Settings = {
  // ... (既存)
  child_mode: boolean; // false: 通常モード, true: 子供モード
};
```

- 不変条件
  - `child_mode` の変更は popup / options のいずれからでも同一の `chrome.storage.local.set` 経由で行う。
  - `child_mode` の値は popup を閉じても保持される (storage 真実)。
  - `child_mode` 自体はタイマーの計時に影響しない。あくまで view レイヤのスイッチ。

## モジュール責務

| モジュール | 責務 |
| --- | --- |
| `src/popup.ts` | `settings.child_mode` を購読し、`document.body` に `child-mode` クラスを付与/除去する。`#toggle-child-mode` change で `patchSettings({ child_mode })`。リセット/スキップ時の確認ダイアログ表示。 |
| `src/popup.css` | `body.child-mode` セレクタ配下で配色・フォントサイズ・当たり判定を上書き。`prefers-reduced-motion` 尊重。 |
| `src/popup.html` | 既存マークアップを共有。`#toggle-child-mode` と確認用 `<dialog>` 要素のみ追加。 |
| `src/options.ts` / `src/options.html` | `Settings.child_mode` のチェックボックスを提供。保存即時で popup と同期。説明文も併記。 |
| `src/background.ts` | 影響なし (タイマーロジックは child_mode を見ない)。`onInstalled` の defaults でのみ初期値を持つ。 |
| `src/storage.ts` | `Settings.child_mode` の型と既定値 (`false`) を提供 (既存)。 |

## 切替フロー (popup)

1. popup 起動時、`loadAndRender()` で `settings.child_mode` を読み、`applyTheme(settings)` が `body` に `child-mode` クラスを付与/除去する (既存実装どおり)。
2. `#toggle-child-mode` change で `patchSettings({ child_mode: target.checked })` を呼ぶ。
3. `chrome.storage.onChanged` で options 側からの変更も popup に伝播する。
4. 子供モード状態を読み上げるため、`aria-pressed` または隠し `aria-live` で `popup_child_mode_on / popup_child_mode_off` を切替時にアナウンスする。

## 視覚仕様

| 項目 | 通常モード | 子供モード |
| --- | --- | --- |
| 進捗色 (work) | `#2f6df4` (青) | `#ff7ab6` (やさしいピンク) |
| 進捗色 (break) | `#2ea66c` | `#4cc88a` (やわらか緑) |
| 進捗色 (long_break) | `#8b5cf6` | `#c084fc` (パステル紫) |
| 残り時間フォントサイズ | 36px | 42px |
| モード/見出しウェイト | 500 | 600 (太字寄り) |
| ボタン min-height | 36px | 44px (タップしやすく) |
| ボタンフォントサイズ | 14px | 16px |
| トグルラベル | 13px | 15px |
| 角丸 (`--radius-md`) | 10px | 14px (より丸い) |
| フォーカスリング | 2px | 3px (見えやすく) |
| アニメ持続時間 | 0.4s | 0.25s (短く、過刺激回避) |

ダークモードでも child-mode の彩度・サイズ規約は同様に適用する。基本トーンは `body.child-mode.theme-dark` / `body.child-mode.theme-light` で個別に微調整可。

CSS の差分は `body.child-mode` セレクタに集約し、HTML/JS の構造変更を最小化する。既存の `body.mode-work / mode-break / mode-long-break` クラスとの組み合わせで色を上書きする (現状 popup.css の `body.child-mode.*` ブロックで既に一部実装済み)。

## ボタン破壊操作の確認

- `#btn-reset` / `#btn-skip` は通常モードでは即時実行。child-mode でのみ確認を挟む。
- 確認 UI は `<dialog id="confirm-action">` を popup.html に 1 つだけ追加し、メッセージは i18n キーで切替:
  - `popup_confirm_reset_title` / `popup_confirm_reset_body`
  - `popup_confirm_skip_title` / `popup_confirm_skip_body`
- ボタン: `common_ok` / `common_cancel`。Enter/Esc で確定/キャンセル。
- 確認後の処理は通常フローと同じ `sendCommand("timer_reset" | "timer_skip")`。
- 通常モードでは `<dialog>` を `showModal()` せず、フローを変えない。

## アクセシビリティ

- `#toggle-child-mode` は `<label>` 直結のチェックボックスで Tab 操作可能。
- 切替直後、隠し領域 (`role="status"`, `aria-live="polite"`) に `popup_child_mode_on` または `popup_child_mode_off` をテキスト挿入してスクリーンリーダーに通知。
- `prefers-reduced-motion: reduce` 時は通常モードと同じく、進捗バーの transition を無効化。
- `prefers-contrast: more` 時は child-mode の進捗色をやや濃く、フォーカスリングを 4px に。
- 大きすぎる文字で 320px 幅の popup を超えないよう、`max-width: 100%` と `min-width: 0` を要素に付与。

## エッジケース

| ケース | 振る舞い |
| --- | --- |
| 通常モード中に options 側で ON にした | `onChanged` 経由で popup に即反映し、`body.child-mode` クラスが付く。タイマーは継続。 |
| child-mode 中にリセット確認ダイアログを開いたまま popup を閉じた | 次回 popup 起動時はダイアログは閉じている (DOM が破棄されるため)。タイマー状態は影響なし。 |
| child-mode 中にユーザー設定で `theme=dark` を選択 | `body.theme-dark.child-mode` の組み合わせで彩度を保ったまま暗背景に切り替わる。 |
| Premium 解放/解除 | child-mode は無料機能なので影響なし。 |
| `prefers-reduced-motion: reduce` + child-mode | アニメ短縮ではなく無効化が優先される。 |
| ストレージ未初期化 | popup は早期 return し、`ensureDefaults()` 後の `onChanged` で再描画。 |

## i18n

新規メッセージキー (ja/en 両方追加):

- `popup_child_mode_on` (既存: 「子供モード ON」)
- `popup_child_mode_off` (既存: 「子供モード OFF」)
- `popup_confirm_reset_title` (新規: 「タイマーをリセットしますか？」)
- `popup_confirm_reset_body` (新規: 「残り時間が初期値に戻ります。」)
- `popup_confirm_skip_title` (新規: 「次のセッションに進みますか？」)
- `popup_confirm_skip_body` (新規: 「いまのセッションは中断されます。」)
- `options_child_mode_label` (既存)
- `options_child_mode_desc` (既存: 「やさしい色合いと大きな文字、シンプルな操作に切り替えます。」)

## 関連メモ

- [[design-big-visual-timer]]: 視覚タイマー本体。child-mode は外観のみ差し替える。
- [[design-sound-mute]]: child-mode 専用の通知音ではなく、共通のミュート制御を使う。
- [[design-break-reminder]]: 通知の文言は子供向けに切り替えないが、将来絵文字を増やす余地あり。
- [[design-session-stats]]: child-mode 中も統計を取り続ける (集計ロジックは同じ)。

## 受け入れ条件 (T020/T021 で検証)

- popup の `#toggle-child-mode` を切り替えると、即時に `body.child-mode` が付き、配色・文字サイズが変わる。
- popup を閉じて再オープンしても、直前の `child_mode` 状態を保持している。
- options 画面で `child_mode` を ON にすると、開いている popup にも `onChanged` 経由で反映される。
- child-mode 中にリセット/スキップを押すと確認ダイアログが開き、キャンセルできる。通常モードでは確認は出ない。
- `prefers-reduced-motion: reduce` 環境で進捗アニメが無効化される。
- ja / en 両方で child-mode 関連の文言が表示できる。
- タイマーの計時は child-mode の切替で影響を受けない (`end_ts` 不変、残り表示は連続)。
