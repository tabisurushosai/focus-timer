# Design: break-reminder

フェーズ遷移時にデスクトップ通知 (`chrome.notifications`) を出す機能と、休憩を放置したユーザーへの「そろそろ戻りませんか」リマインダー機構をまとめた仕様。
popup を閉じていても集中→休憩 / 休憩→集中の節目を見逃さないようにする一方、「通知が多すぎる」「子供が驚く」「会議中は静かに」というユーザー要件を `notification_enabled` / `break_reminder_enabled` の独立トグルと、節度ある発火頻度 (フェーズ毎 1 回 + アイドル時 1 回) で両立させる。

## 目的 / 非目的

- 目的
  - work / break / long_break の遷移時に、デスクトップ通知 (`chrome.notifications`) を 1 回だけ発火する。
  - 休憩フェーズで `auto_start_work === false` のとき、ユーザーが popup を開かないまま放置していれば一度だけ「集中に戻りませんか」とリマインドする。
  - 通知クリックで popup (extension の action) を開ける導線を提供する。
  - Manifest V3 の制約下 (service worker 短命) で `chrome.alarms` のみを使ってリマインダーを駆動する。
  - 音 ([[design-sound-mute]]) と通知 (`chrome.notifications`) を独立に制御する: 音だけ消したい / 通知だけ消したい両方を許容。
  - 子供モード / Premium 解放状態とは独立に動く (本機能は無料・常時提供)。
- 非目的
  - 通知センターへの履歴蓄積 / 永続バッジ (Chrome / OS 仕様に踏み込まない)。
  - 「集中していないこと」を検知する活動推定 (タブ・URL・キーストロークの観察はしない)。
  - SNS・カレンダー等の外部通知 (純粋にローカル通知のみ)。
  - スヌーズ・複数回再リマインド (ノイズになるため、1 アイドル区間につき最大 1 回)。
  - リッチ通知 (画像・ボタン複数) の活用 (`type: "basic"` に固定)。
  - 通知音のカスタム再生 (OS デフォルト音に委ねる。チャイムは [[design-sound-mute]] の責務)。

## ユーザー要件

| 要件 | 実装上の要件 |
| --- | --- |
| 集中が終わったと気付きたい | work → break / work → long_break の遷移で「休憩しましょう」通知。 |
| 休憩終わりに気付きたい | break / long_break → work の遷移で「セッション完了/集中に戻りましょう」通知。 |
| 休憩を取りすぎないよう促したい | 休憩フェーズ開始から `break_min + 5` 分経過しても running=false のままなら 1 回だけリマインダー。 |
| 通知が多くて困る | options の `#opt-notification-enabled` を OFF にすれば全通知が止まる。 |
| 休憩リマインダーだけ止めたい | options の `#opt-break-reminder-enabled` を OFF にすれば「アイドル時の休憩リマインダー」のみ止まる (フェーズ遷移通知は残る)。 |
| 通知から popup を開きたい | 通知本体クリックで `chrome.action.openPopup()` を試行。失敗時は何もしない (Chrome の API 制限を許容)。 |
| 子供向け配慮 | 通知文言は柔らかい平易な語に統一 (絵文字は使わず、i18n テキストのみ)。 |

## 状態モデル

`src/storage.ts` の既存スキーマを再利用 (新規キーなし)。

```ts
type Settings = {
  // ... (既存)
  notification_enabled: boolean;       // 既定 true。全 chrome.notifications のマスタースイッチ
  break_reminder_enabled: boolean;     // 既定 true。アイドル時の休憩リマインダーのみを制御
};
```

- 不変条件
  - `notification_enabled === false` のときは一切 `chrome.notifications.create` を呼ばない (アイドルリマインダー含む)。
  - `notification_enabled === true && break_reminder_enabled === false` のときは「フェーズ遷移通知」のみ発火、「アイドル休憩リマインダー」は発火しない。
  - リマインダー用 `chrome.alarms` (`ALARM_BREAK_REMINDER`) は break / long_break フェーズの間だけ存在する。次フェーズへ遷移した瞬間に `chrome.alarms.clear` で除去する。
- popup / options のチェックボックスはいずれも **チェック ON = 通知を出す** という UI 規約で統一 (sound-mute の popup ミュートと逆方向だが、こちらは options のみで切替する設計)。

## モジュール責務

| モジュール | 責務 |
| --- | --- |
| `src/notifications.ts` (新規) | 通知の単一窓口。`notifyPhaseTransition(to, settings)` と `scheduleBreakReminder(settings, breakStartTs)` / `clearBreakReminder()` / `handleBreakReminderAlarm()` を提供。`notification_enabled` を見て早期 return。`chrome.notifications` 非対応環境では no-op。 |
| `src/background.ts` | `handlePhaseEnd()` / `skip()` 完了後にフェーズ遷移通知を発火 (reset は無音)。break / long_break に入ったタイミングで `scheduleBreakReminder`、work に戻るタイミングで `clearBreakReminder`。`chrome.alarms.onAlarm` で `ALARM_BREAK_REMINDER` を受けて `handleBreakReminderAlarm` に委譲。`chrome.notifications.onClicked` で popup を開く。 |
| `src/popup.ts` | 影響なし (通知の出し分けは background が一元化)。ただし「設定リンク」経由で options に遷移できることを確認。 |
| `src/options.ts` / `src/options.html` | 既存の `#opt-notification-enabled` / `#opt-break-reminder-enabled` 双方向バインドを維持。`break_reminder_enabled` の説明文 (`options_break_reminder_hint`) を新規追加し、「フェーズ遷移通知は別の項目です」と明示。 |
| `src/storage.ts` | 変更なし。既存の `notification_enabled` / `break_reminder_enabled` を流用。 |
| `manifest.json` | 既存の `"notifications"` permission を流用 (追加なし)。 |

## 発火タイミングと「鳴る瞬間」

通知 (`chrome.notifications.create`) は次の 3 種類のイベントで発火する。いずれも `notification_enabled === true` が前提。

1. **フェーズ遷移通知** (`handlePhaseEnd` / `skip` の直後、`reset` では発火しない)
   - work → break / work → long_break: タイトル `popup_break_reminder`、本文 `popup_break_reminder_body`、`notification_id = "focus-timer:transition"`。
   - break → work / long_break → work: タイトル `popup_session_complete`、本文 `popup_session_complete_body`、同 `notification_id`。
   - 同じ `notification_id` を使い回し、`chrome.notifications.create` の再呼出しで自動的に置換 (古い通知が積み上がらない)。
2. **アイドル休憩リマインダー** (`ALARM_BREAK_REMINDER` 発火時)
   - 条件: 現在の `timer.mode` が `break` または `long_break` かつ `running === false` かつ `break_reminder_enabled === true`。
   - 内容: タイトル `popup_break_reminder_idle_title`、本文 `popup_break_reminder_idle_body`、`notification_id = "focus-timer:idle-reminder"` (フェーズ遷移と別 ID で重ねる)。
   - 1 アイドル区間につき 1 回のみ。発火後はアラームを再スケジュールしない (`clearBreakReminder` で完全停止)。
3. **通知クリック** (`chrome.notifications.onClicked`)
   - `notification_id` を問わず `chrome.action.openPopup()` を試行 (`chrome.action.openPopup` が無い古い Chrome では `chrome.windows.create` 等を試さず諦める)。

「鳴る瞬間」は [[design-sound-mute]] のチャイムと同じイベント (`handlePhaseEnd` 直後) だが、両者は独立判定なので「音だけ鳴る」「通知だけ出る」「両方」「どちらも出ない」の 4 状態すべてが取りうる。視覚情報 ([[design-big-visual-timer]] の色変化) は両者と完全に独立。

## アラームスケジューリング

- 名前: `ALARM_BREAK_REMINDER = "focus-timer:break-reminder"` (既存定数を再利用)。
- 起動条件: `handlePhaseEnd` / `skip` で次フェーズが `break` または `long_break` で、かつ `auto_start_work === false` のとき。
- 起動時刻: フェーズ開始から `break_min` または `long_break_min` 分 + 5 分後 (= 休憩予定時間を 5 分過ぎた時点)。
- 解除条件:
  - 次フェーズへ遷移した瞬間 (`handlePhaseEnd` / `skip` 経由)。
  - ユーザーが手動 `timer_start` / `timer_resume` で running=true にした瞬間 (`startOrResume` 内で `clearBreakReminder` を呼ぶ)。
  - `timer_reset` 実行時。
- 再スケジュールは行わない: 「2 回目のリマインダー」「スヌーズ」はノイズになるため設計上採用しない。
- アラーム発火時に `break_reminder_enabled === false` または `notification_enabled === false` だったら、`chrome.notifications.create` を呼ばずに静かに終了する (アラーム自体は単発)。

## モジュール契約 (notifications.ts)

```ts
export type TransitionTone = "work" | "break" | "long_break";

export function notifyPhaseTransition(
  to: TransitionTone,
  settings: Settings,
): Promise<void>;
// notification_enabled === false で no-op。例外は内部で握りつぶす。

export function scheduleBreakReminder(
  settings: Settings,
  to: TransitionTone,
  breakStartTs: number,
): Promise<void>;
// to が "break" / "long_break" のときだけアラームを作成。"work" のときは clearBreakReminder を呼ぶ。

export function clearBreakReminder(): Promise<void>;
// 常に冪等。アラームが無くてもエラーにしない。

export function handleBreakReminderAlarm(): Promise<void>;
// background 側の chrome.alarms.onAlarm から委譲される。条件不成立なら静かに終了。
```

`background.ts` は遷移直後に以下を順に呼ぶ:

```ts
await notifyPhaseTransition(next, settings);
await scheduleBreakReminder(settings, next, breakStartTs);
```

`startOrResume` / `reset` の中では `await clearBreakReminder()` を呼ぶ (ユーザー操作で「リマインダーは不要」と推測できるため)。

## 通知ペイロードの統一仕様

```ts
chrome.notifications.create("focus-timer:transition", {
  type: "basic",
  iconUrl: chrome.runtime.getURL("icons/icon128.png"),
  title: t("popup_break_reminder"),
  message: t("popup_break_reminder_body"),
  priority: 0,
  silent: true,         // OS 通知音は止める。音は sound-mute で別途制御。
  requireInteraction: false,
});
```

- `silent: true` を必ず指定し、OS 既定音と [[design-sound-mute]] のチャイムが二重に鳴らないようにする。
- `priority: 0` (普通)。子供モードでも `priority: 2` には上げない (過刺激回避)。
- `iconUrl` は同梱の `icons/icon128.png`。
- `eventTime` は省略 (アラーム時刻と乖離しても問題ない)。

## クリック導線

- `chrome.notifications.onClicked` で `notification_id` を問わず `chrome.action.openPopup()` を試行。
- Chrome 99+ の `chrome.action.openPopup` は呼び出し元コンテキスト制限が強いため、失敗時は `console.warn` でログのみ残す (ユーザーへの追加導線は提供しない)。
- 通知本体には `buttons` を追加しない (操作ミス防止と i18n コスト削減)。

## options 仕様

- `#opt-notification-enabled`: マスタースイッチ。OFF にすると `break_reminder_enabled` の状態に関わらず通知が完全に止まる。`opt-break-reminder-enabled` を visually disabled (CSS opacity + `disabled` 属性) にする。
- `#opt-break-reminder-enabled`: アイドル休憩リマインダーのトグル。説明文 (`options_break_reminder_hint`) で「フェーズの切り替わり通知とは別」と明示。
- `#opt-notification-enabled` を OFF から ON に戻したとき: 即時 `chrome.notifications.getPermissionLevel` で許可を確認し、`"denied"` なら inline メッセージ (`options_notification_denied_hint`) を表示する。
- 「テスト通知」ボタンは設けない (Chrome Web Store 審査で混乱を招くため)。

## アクセシビリティ

- 通知本体は OS が読み上げる (拡張側のアクセシビリティ責務外)。
- options のチェックボックスは `<label>` 直結。
- `aria-live` は popup 側に追加しない (通知は OS 側で表現済)。
- `prefers-reduced-motion`: 影響なし (通知に CSS アニメーションはない)。
- `prefers-contrast: more`: 影響なし (通知本体は OS テーマに従う)。

## エッジケース

| ケース | 振る舞い |
| --- | --- |
| `chrome.notifications` 非対応の古い Chrome | `chrome.notifications` の存在チェックで早期 return。例外を投げず no-op。 |
| OS 通知が無効化 / 拒否されている | `chrome.notifications.create` のコールバックでエラーを受け、`console.warn` のみ。ユーザーには表示しない。 |
| popup が開いている状態でフェーズ遷移 | 通常通り通知も発火する。popup 側で重複表示しない (popup は通知を出さない責務)。 |
| 連続 `skip` で 100ms 以内に複数遷移 | `chrome.notifications.create` の同一 `notification_id` 上書きにより、最後の状態のみ通知される。 |
| `auto_start_work === true` で break が始まった | アイドルリマインダーは「ユーザーが popup を放置している」前提なので **スケジュールしない** (`scheduleBreakReminder` 内で条件分岐)。 |
| 休憩中に `timer_reset` を実行 | 同じ break フェーズに留まるが、`clearBreakReminder` でアラームを消す。再度 `timer_start` してもアラームは再スケジュールしない (`startOrResume` で `clearBreakReminder` のみ)。 |
| アラーム発火時にフェーズが work に戻っていた | `handleBreakReminderAlarm` で `timer.mode` が work なら静かに終了。 |
| `notification_enabled` を ON のままブラウザ通知許可を拒否 | `chrome.notifications.create` の `lastError` を読み、`console.warn` のみ。設定値は変えない (ユーザーが OS 側で許可すれば直る)。 |
| Premium 解放 / 解除 | 影響なし (本機能は無料)。 |
| 子供モード | 通知の文言・優先度は変えない (デザイン上は変化なし)。将来 child_mode 専用文言が追加される可能性があるが本タスクの範囲外。 |
| service worker が停止中にアラーム時刻が到来 | `chrome.alarms` は service worker を起こす。`reconcileAfterWake` 経由でも `chrome.alarms.onAlarm` リスナーが先に走るので問題なし。 |
| break 中に `break_min` を変更 | 進行中の `end_ts` は不変 ([[design-big-visual-timer]] の規約)。アラームも再計算しない (1 回限りのリマインダーなので影響軽微)。 |

## マニフェスト/権限への影響

- `permissions` の `"notifications"` / `"alarms"` は既存のため追加なし。
- `host_permissions` は不要 (通知は同梱アイコンのみ)。
- `legal/PRIVACY.md` には「通知内容は端末内で生成し、外部送信しない」旨を 1 行追記する余地を残す (実装タスク T029 で確認)。

## i18n

新規メッセージキー (ja/en 両方追加。本タスクの設計段階ではキー一覧のみ確定、実体追加は T029 実装時):

- `popup_break_reminder_idle_title` (例: "休憩、長くなっていませんか？" / "Still on a break?")
- `popup_break_reminder_idle_body` (例: "そろそろ集中に戻りましょう。" / "Ready to refocus?")
- `options_break_reminder_hint` (例: "フェーズの切り替わり通知とは別に、休憩を取りすぎた時にお知らせします。" / "Independent of phase-change notifications; nudges you if a break runs long.")
- `options_notification_denied_hint` (例: "ブラウザの通知が許可されていません。OS の設定をご確認ください。" / "Browser notifications are blocked. Please check your OS settings.")

既存キー: `popup_break_reminder` / `popup_break_reminder_body` / `popup_session_complete` / `popup_session_complete_body` / `options_notification_enabled` / `options_break_reminder_enabled` はそのまま流用。

## 関連メモ

- [[design-big-visual-timer]]: フェーズ遷移の視覚情報。通知と冗長化された情報源。
- [[design-child-mode]]: 通知の文言・優先度は変えない。本タスクの範囲外。
- [[design-sound-mute]]: 通知 (`chrome.notifications`) と音 (offscreen chime) は独立。`silent: true` で OS 通知音を抑止し、二重再生を防ぐ。
- [[design-session-stats]]: 統計記録と通知発火は同じ `handlePhaseEnd` イベントだが、責務は分離。
- [[storage]]: `Settings.notification_enabled` / `Settings.break_reminder_enabled` の真実。

## 受け入れ条件 (T029/T030 で検証)

- work → break / work → long_break の遷移時にデスクトップ通知が 1 回出る (`notification_enabled === true` のとき)。
- break → work / long_break → work の遷移時に「セッション完了」通知が 1 回出る。
- 同じ `notification_id` を使うため、連続遷移で通知が積み上がらない。
- `notification_enabled === false` にすると、その後の遷移で通知が出ない。
- `break_reminder_enabled === false` のとき、フェーズ遷移通知は出るがアイドルリマインダーは出ない。
- 休憩フェーズ開始から `break_min + 5` 分経過しても running=false ならアイドルリマインダーが 1 回出る。
- アイドルリマインダーは同じ休憩区間で 2 回目は出ない。
- ユーザーが `timer_start` / `timer_resume` / `timer_reset` を実行すると、未発火のアイドルアラームが解除される。
- `auto_start_work === true` のときはアイドルリマインダーがそもそもスケジュールされない。
- 通知クリックで popup (extension の action) が開く (`chrome.action.openPopup` 成功時)。
- `reset()` では通知が発火しない。`skip()` では遷移時の通知が出る。
- `silent: true` が必ず設定され、OS 既定の通知音は鳴らない (チャイムは [[design-sound-mute]] で別軸制御)。
- `chrome.notifications` 非対応環境で例外を投げず、no-op で完了する。
- ja / en 両方で break-reminder 関連の文言が表示できる。
