# Design: session-stats

「今日どれだけ集中できたか」「今週の傾向」を可視化することで継続を支援する統計機能。
集計の真実は `chrome.storage.local.stats` のみ。外部送信は一切しない (オフライン前提)。

## 目的 / 非目的

- 目的
  - 完了した集中 (work) セッション数と集中時間 (分) を日次で蓄積する。
  - popup に「今日の集中セッション数」「今日の集中分」を最小コストで常時表示する。
  - options 画面で過去 7 日のサマリ (棒グラフ) を提供する (無料)。
  - Premium では過去 30 / 90 日のサマリ、合計、CSV エクスポートを提供する。
  - 子供モード/ダークモード/通常モードのどれでも整合する。
- 非目的
  - サーバ送信・アカウント連携・共有機能 (個人情報を外部に出さない原則)。
  - 細粒度ログ (どのタブで何をしたか) — Chrome Web Store ポリシーと SPEC 制約に反する。
  - 中断/破棄したセッションのカウント (完了 = `mode==="work"` の `phase_end` または明示 `skip` 後のみ加算)。
  - 統計に基づくゲーミフィケーション (連続日数バッジ等) — 本タスクの範囲外、将来検討。

## ユーザー要件

| 要件 | 実装上の要件 |
| --- | --- |
| 今日の進捗を popup ですぐ見たい | `#session-count` (既存) + `#focus-min-today` (新規) を popup に表示 |
| 過去 7 日の傾向を眺めたい | options に `7日サマリ` セクションを置き、横棒で日別 focus_min を表示 |
| 無料でも基本統計が見たい | 7日サマリ + 累計分は無料、Premium 限定機能ではない |
| 詳細を見たい (Premium) | 30/90 日サマリ・累計合算・CSV エクスポートを Premium ゲート |
| プライバシーが心配 | `stats` は `chrome.storage.local` のみ。Reset ボタンで全削除可。 |
| 子供モードでも崩れない | 数字主体・色弱配慮。`body.child-mode` で文字サイズだけ拡大、形は同じ。 |

## 状態モデル

`src/storage.ts` の既存スキーマを再利用 (変更なし)。

```ts
type DailyStat = { focus_min: number; sessions: number };

type Stats = {
  daily: Record<string, DailyStat>; // key: "YYYY-MM-DD" (ローカル時刻基準)
  total_focus_min: number;
  total_sessions: number;
};
```

- 不変条件
  - `daily[YYYY-MM-DD].sessions >= 0`、`focus_min >= 0`。
  - `total_*` は `daily` の単純合計 (どこかでズレたら `recomputeTotals()` で再構築)。
  - `daily` のキーは「集中セッションが完了した瞬間のローカル日付」。深夜0時を跨ぐ場合は終了時刻の日付に計上する (= 同一セッションが2日に跨いでも 1 日に集約)。
- 保持ポリシー
  - 既定保持: 直近 100 日分 (約 3 か月強)。それ以前は自動で削除し `total_*` には残す。
  - Premium でも保持上限は同じ (ストレージ肥大防止)。CSV エクスポートで長期保存はユーザ責任。

## モジュール責務

| モジュール | 責務 |
| --- | --- |
| `src/stats.ts` (新規) | 「完了セッションを記録する」`recordWorkCompletion(durationMs, endTs)`、「日付キー生成」`localDateKey(ts)`、「保持上限の刈り取り」`pruneOldDays(stats, keepDays)`、「合計再計算」`recomputeTotals(stats)` を提供。 |
| `src/background.ts` | work フェーズ完了 (handlePhaseEnd 内で `mode === "work"` を遷移する分岐) と `skip()` の work→次 のときに `recordWorkCompletion(focusedMs, now)` を呼ぶ。 |
| `src/popup.ts` | `stats.daily[today]` を購読して `#session-count` と `#focus-min-today` を更新。`onChanged` で即時反映。 |
| `src/popup.html` | `meta-row` 群に `focus_min` 表示行を追加 (data-i18n: `popup_focus_min_today`)。 |
| `src/options.ts` / `src/options.html` | `7日サマリ` (無料) と `30/90日サマリ / 合計 / CSV出力` (Premium) のセクション。Premium UI は `hasPremiumAccess()` で gating。 |
| `src/storage.ts` | 既存。`Stats` 型と `DEFAULT_STATS` を提供。新規キーは追加しない。 |
| `src/premium.ts` (T031) | `hasPremiumAccess()` を参照するのみ (本タスクでは仕様確定だけ、実装は T031〜)。 |

`background.ts` 以外から `stats` を書かない。読み手 (popup/options) は購読のみ。

## 計上トリガと「focus_min」の定義

- 計上は **work セッションが完了したとき** に 1 回のみ:
  1. `handlePhaseEnd()` で `timer.mode === "work"` のとき: 完了したフォーカス時間 = `totalForMode("work", settings)`。
  2. `skip()` で `timer.mode === "work"` のとき: 完了したフォーカス時間 = `totalForMode("work", settings) - max(0, end_ts - now)`。ただし「ほぼ完了 (>= 60秒経過)」のみ計上し、それ未満はカウントしない。
- 1セッションの集中分は「分単位、整数、切り捨て」 (`Math.floor(ms / 60_000)`)。
  - 例: 25分セッション完了 → `focus_min += 25`、`sessions += 1`。
  - 中断 (pause→reset) は計上しない (`reset()` 経路はカウンタを触らない)。
- 計上日付: 完了時刻 `now` のローカル日付を `localDateKey(now)` で算出。タイムゾーンは Chrome のシステム TZ に従う。

## モジュール契約 (stats.ts)

```ts
export function localDateKey(ts: number): string; // "YYYY-MM-DD"
export function recordWorkCompletion(
  stats: Stats,
  focusMs: number,
  endTs: number,
): Stats; // pure: 新しい stats を返す
export function pruneOldDays(stats: Stats, keepDays: number): Stats;
export function recomputeTotals(stats: Stats): Stats;
export function lastNDays(stats: Stats, n: number, today: number): Array<{
  date: string;
  focus_min: number;
  sessions: number;
}>; // 古い日付から新しい日付の順、欠損日は 0 埋め
```

すべて純関数。`background.ts` は `get("stats")` → 変換 → `set("stats", next)` の三段で呼び出す (競合は短時間ゆえ無視)。

## popup 表示仕様

- 既存 `#session-count` は「今日完了した集中セッション数」を表示 (現状は `timer.session_count`)。本タスクで `stats.daily[today].sessions` に切り替え、`timer.session_count` は長休憩判定 (`sessions_until_long_break`) 専用に残す。
- 新規 `#focus-min-today`: `stats.daily[today].focus_min` を `popup_focus_min_today` ラベル付きで表示。
- 子供モード時は数字をやや大きく、ラベルは同サイズ ([[design-child-mode]] の規約に従う)。
- `aria-live="polite"`。更新は完了時のみなので頻繁ではない。

## options 7日サマリ仕様 (無料)

- セクション見出し `options_stats_7days_title`。
- 表示は 7 本の横棒。各行: `日付ラベル (M/D) | 棒 | "Nm Ns"`。最長日を 100% に正規化。
- 描画は CSS のみ (`<div role="img" aria-label="...">` + `width: %`)。SVG 不要。
- `prefers-reduced-motion` 尊重で棒の transition を無効化。
- 「すべてのデータを削除」ボタン (`options_stats_clear`) で `set("stats", DEFAULT_STATS)`。確認ダイアログ (child-mode のと共有) を必ず挟む。

## options Premium サマリ仕様 (Premium / Trial)

- セクション見出し `options_stats_premium_title`、`hasPremiumAccess(premium)` が `true` のときのみ表示。`false` のときはアップグレード誘導を表示 (T032 範疇)。
- 30日サマリと 90日サマリの切替タブ。
- 累計 `total_focus_min` / `total_sessions` を表示。
- 「CSV エクスポート」ボタン: `daily` を `date,focus_min,sessions` 形式に変換し、`Blob` + `chrome.downloads.download` でローカル保存 (ホスト権限不要)。
- `chrome.downloads` permission は manifest.json に追加する必要があるかを T023 実装時に確認 (現状の manifest に未追加なら追加)。

## アクセシビリティ

- 7日サマリ各行は `role="listitem"`、コンテナは `role="list"`。スクリーンリーダーは「6月10日: 75分, 3セッション」のように読み上げ。
- 棒自体は `aria-hidden="true"` (装飾)。情報は数字側で読み上げ。
- 「すべてのデータを削除」は赤系アクセント + 確認ダイアログ。Tab 順は最後。
- フォーカス可視: `:focus-visible` で 2px ring (child-mode は 3px)。

## エッジケース

| ケース | 振る舞い |
| --- | --- |
| 端末スリープ → 復帰 で `handlePhaseEnd` が遅延発火 | 完了日付は `endTs` ベースなので、本来終わるはずだった日付に計上 (`localDateKey(endTs)`)。スリープ復帰でも履歴日付がズレない。 |
| 日付境界をまたぐ work セッション (例: 23:55 開始, 24:25 終了) | 終了時刻 (00:25) のローカル日付に 25 分を計上。前日には積まない。 |
| OS 時計逆行 | `localDateKey(endTs)` の値も逆行するため、新しい日に積まれていた値より過去日に積まれる可能性がある。ユーザー操作で復旧 (削除ボタン)、自動修正はしない。 |
| `skip()` 直後にすぐ `skip()` (60秒未満で2連発) | 1回目: 経過 60秒未満なら計上なし。2回目: 同様。意図的乱用にはカウンタが反応しない。 |
| `daily` が 100 日を超えた | `pruneOldDays(stats, 100)` を `recordWorkCompletion` のあとに毎回呼ぶ。削除分は `total_*` には残す (recompute しない)。 |
| Premium 解除 (Trial 終了) | UI のセクションが隠れるだけ。`stats` 自体は触らない。 |
| ストレージ未初期化 | popup/options ともに `ensureDefaults()` 後の `onChanged` で再描画。 |
| 設定で `work_min` を変更 | 既に保存済みの `focus_min` には影響なし。以降の完了分は新しい `work_min` で計上。 |

## i18n

新規メッセージキー (ja/en 両方追加。本タスクの設計段階ではキー一覧のみ確定、実体追加は T023 実装時):

- `popup_focus_min_today` (例: "今日の集中分" / "Today's focus minutes")
- `options_stats_7days_title` (例: "直近7日の集中" / "Last 7 days")
- `options_stats_30days_title` (Premium)
- `options_stats_90days_title` (Premium)
- `options_stats_total_focus_min` (例: "累計集中分" / "Total focus minutes")
- `options_stats_total_sessions` (例: "累計セッション数" / "Total sessions")
- `options_stats_clear` (例: "統計をすべて削除" / "Clear all stats")
- `options_stats_clear_confirm_title` / `options_stats_clear_confirm_body`
- `options_stats_export_csv` (Premium, 例: "CSV でエクスポート" / "Export as CSV")
- `options_stats_premium_upgrade` (Premium 未解放時の誘導)

## マニフェスト/権限への影響

- `chrome.downloads` を CSV エクスポートに使う場合のみ追加。本タスクの設計上は「追加することを T023 実装で確定」とする。`activeTab` / `storage` / `alarms` / `notifications` は既存のまま。
- 外部送信なしの原則は不変 (CSV は `chrome.downloads` 経由でローカル保存のみ、URL は `blob:` か `data:` を使う)。

## 関連メモ

- [[design-big-visual-timer]]: `session_count` の更新ポイントを共有する。`timer.session_count` は long-break 判定専用に残し、表示用は `stats.daily[today].sessions` に切替。
- [[design-child-mode]]: 数値はそのまま、フォントサイズだけ拡大。色は child-mode プリセットを継承。
- [[design-sound-mute]]: 影響なし (記録は無音で行う)。
- [[design-break-reminder]]: 完了時に rep。recordWorkCompletion と通知発火は同じイベントだが、責務は別モジュール。

## 受け入れ条件 (T023/T024 で検証)

- work セッションが満了 (phase_end) すると、`stats.daily[今日].sessions` が +1、`focus_min` が `work_min` 分増える。
- `skip` 時、経過 60 秒未満なら統計に加算されない。60 秒以上経過なら経過分 (分単位切捨て) が加算され、`sessions` も +1 される。
- `reset` では統計が変化しない。
- popup の `#session-count` と `#focus-min-today` が `onChanged` で即時更新される。
- options の 7 日サマリが、過去 7 日間 (今日を含む) の `focus_min` を欠損日 0 埋めで表示する。
- options の「統計をすべて削除」を押し、確認に OK で `stats` が `DEFAULT_STATS` に戻る。
- `daily` が 100 日を超えると、古い日が自動で剪定される (`total_*` は維持)。
- Premium / Trial の間は 30/90 日サマリと CSV エクスポートが表示される。解除後は隠れる。
- `prefers-reduced-motion: reduce` 環境で棒の transition が無効化される。
- ja / en 両方で session-stats 関連の文言が表示できる。
