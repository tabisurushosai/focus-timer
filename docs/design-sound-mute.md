# Design: sound-mute

フェーズ境界 (work→break, break→work, →long_break) で短い通知音を鳴らす機能と、それを 1 操作で止められるミュート機構をまとめた仕様。
「静かに使いたい」「教室で使いたい」「感覚過敏で大きい音が苦手」というユーザー要件を、設定変更なしの「ワンタップ・ミュート」と、設定画面側の永続トグル + 音量スライダで両立させる。

## 目的 / 非目的

- 目的
  - work / break / long_break の遷移時に、短い (~600ms 以内) 通知音を 1 回だけ鳴らす。
  - popup のヘッダーにある `#toggle-mute` で、設定画面を開かずに即時 ON/OFF できる。
  - 音量を 0〜100% で滑らかに調整できる (既定 60%)。
  - Manifest V3 の制約下 (service_worker から直接 `Audio` を使えない) でも安定して再生する。
  - 音と通知 (`chrome.notifications`) を独立に制御する: 音だけ消したい / 通知だけ消したい両方を許容。
  - 子供モード / ダークモード / 通常モードと干渉しない。
- 非目的
  - BGM・連続再生・タイマー中のティック音 (集中の妨げになるため鳴らさない)。
  - 通知音をユーザー毎にカスタムアップロード (`chrome.storage.local` に音声バイナリを保存しない方針 / Premium 範囲外)。
  - 音声録音や音声入力 (`microphone` 権限は取得しない)。
  - 遠隔再生・OS のフォーカス補助 API (`alarms` の音は使わない)。
  - "Do Not Disturb" 連携 (OS 個別仕様に踏み込まない)。

## ユーザー要件

| 要件 | 実装上の要件 |
| --- | --- |
| 静かに使いたい (図書館・会議中) | popup `#toggle-mute` を 1 クリックで `sound_enabled=false`。即時反映。 |
| 教室で複数台同時 | 音量を低く設定し、最初の起動で「鳴ることがある」旨を i18n 文言で示唆 (`options_sound_hint`)。 |
| 感覚過敏 | 既定音は柔らかい単音 (Sine / 三角波) を生成 or 短い WAV。音量 0% でも UI 上はミュート扱いにする。 |
| 通知だけ欲しい / 音だけ欲しい | `notification_enabled` と `sound_enabled` を独立扱い。両方 OFF でも視覚的遷移 (big-visual-timer) は止めない。 |
| 設定を覚えてほしい | `Settings.sound_enabled` / `Settings.sound_volume` に永続化 (既存スキーマを使用、変更なし)。 |
| 子供モードでも誤操作で大音量が出ない | 子供モードで音量を変更しても上限を 80% に丸める。100% は通常モード時のみ。 |

## 状態モデル

`src/storage.ts` の既存スキーマを再利用 (新規キーなし)。

```ts
type Settings = {
  // ... (既存)
  sound_enabled: boolean; // 既定 true
  sound_volume: number;   // 0.0 - 1.0、既定 0.6
};
```

- 不変条件
  - `sound_volume` は常に `[0, 1]` にクランプ。`NaN` は既定値に置換 (既存 `clampVolume` を再利用)。
  - `sound_enabled === false` のときは `sound_volume` を変更しても音は鳴らない (ミュート優先)。
  - `sound_volume === 0` のときも実音は鳴らさず、`chrome.offscreen` 文書を生成しない (リソース節約)。
- 表示と実体の差
  - popup の `#toggle-mute` は **チェック ON = ミュート** という UI 規約 (現状の `popup.ts` に合わせる: `els.toggleMute.checked = !settings.sound_enabled`)。
  - options の `#opt-sound-enabled` は **チェック ON = 音を出す** という UI 規約。両者で意味が逆だが、保存値は常に `sound_enabled` に統一。

## モジュール責務

| モジュール | 責務 |
| --- | --- |
| `src/sound.ts` (新規) | 音再生の単一窓口 `playPhaseTransition(toMode, settings)` を提供。内部で `chrome.offscreen` ドキュメントの存否確認 → 作成 → `chrome.runtime.sendMessage({type:"sound_play", ...})` を行う。`sound_enabled === false` または `sound_volume === 0` のときは何もしない (no-op)。 |
| `src/offscreen.html` (新規) | `<audio>` 要素を 1 つ持つ最小 HTML。`offscreen.ts` を読み込む。 |
| `src/offscreen.ts` (新規) | `chrome.runtime.onMessage` で `sound_play` を受け、`HTMLAudioElement.src` に同梱の WAV (data URI または `chrome.runtime.getURL`) を設定して `play()`。`audio.volume` は受信したボリュームを適用。再生完了で `chrome.offscreen.closeDocument()` をデバウンス (5 秒後にアイドルなら閉じる)。 |
| `src/background.ts` | `handlePhaseEnd()` のフェーズ遷移直後と `skip()` の遷移直後に `playPhaseTransition(nextMode, settings)` を呼ぶ。auto_start_* の有無に関係なく「遷移したこと」を音で通知。 |
| `src/popup.ts` | `#toggle-mute` change で `patchSettings({ sound_enabled: !target.checked })`。`onChanged` を購読し、トグル状態を `!settings.sound_enabled` に同期。 |
| `src/options.ts` / `src/options.html` | `#opt-sound-enabled` / `#opt-sound-volume` の双方向バインド (既存)。子供モード時の上限 (0.8) を `step` ではなく `max` 属性で表現せず、保存時クランプ (`clampVolumeForMode`) で実装。 |
| `src/storage.ts` | 変更なし。既存の `sound_enabled` / `sound_volume` を流用。 |
| 音声アセット (`assets/chime.wav` または埋め込み) | 200〜600ms、サンプリングレート 44.1kHz、モノラル、ピーク -6dBFS の柔らかい単音 (≦ 8KB)。 |

## 再生トリガと「鳴る瞬間」

- トリガは **フェーズが切り替わった直後** に 1 回:
  1. `handlePhaseEnd()`: `set("timer", { mode: next, ... })` 完了の **後** に呼ぶ (storage が新モードに反映されたあと)。
  2. `skip()`: 同上。`reset()` では鳴らさない (ユーザー意図的な中断は通知不要)。
- 同時並行で連発した場合 (例: 連続 skip): 100ms のデバウンスで 1 回だけ鳴らす (`sound.ts` 内で `lastPlayedTs` を保持)。
- フェーズ別の音は 1 種類のみ (`chime.wav`)。`toMode` で音を変えない (Premium 拡張時に差替を検討)。
- 「鳴る瞬間」と big-visual-timer の色変化は同じイベントなので、視聴覚同時に届く。`prefers-reduced-motion` でアニメは消えるが、音は別軸 (`sound_enabled` で制御)。

## オフスクリーン文書プロトコル

```ts
// background → offscreen
type SoundMsg = { type: "sound_play"; src: string; volume: number };
// offscreen → background (任意)
type SoundAck = { type: "sound_played"; ok: boolean; error?: string };
```

- 既に同名の offscreen がある場合は `chrome.offscreen.hasDocument()` で判定し、二重生成しない。
- `reasons: ["AUDIO_PLAYBACK"]`、`justification` は i18n に依存しない英文固定 ("Play phase-transition chime for the focus timer.")。
- 再生失敗 (ユーザージェスチャ未取得等) は通知に降格しない (`break-reminder` の通知は別軸)。失敗ログは `console.warn` のみ。

## モジュール契約 (sound.ts)

```ts
export type PhaseTone = "work" | "break" | "long_break";

export function isSoundActive(settings: Settings): boolean;
// sound_enabled かつ sound_volume > 0 のとき true。

export function effectiveVolume(settings: Settings): number;
// 子供モード時に 0.8 でクランプ。0〜1。

export async function playPhaseTransition(
  to: PhaseTone,
  settings: Settings,
  now?: number,
): Promise<void>;
// no-op or fire-and-forget。例外は内部で握りつぶす (通知側の責務に影響させない)。
```

`background.ts` は `await playPhaseTransition(next, settings)` を 1 行で呼ぶ。返り値を待つが、内部実装は短時間で resolve する (offscreen への post まで)。

## popup ミュート操作仕様

- `#toggle-mute` は `<input type="checkbox">`。ON = ミュート (現状実装どおり)。
- アクセシビリティ: `aria-pressed` ではなく、ラベル文言を `popup_mute` / `popup_unmute` で切替 (i18n キー既存)。
- 子供モードで `#toggle-mute` を切り替えても確認ダイアログは出さない (破壊操作ではないため)。
- ミュート切替時、隠し `aria-live` 領域に `popup_sound_off` / `popup_sound_on` を出す。
- ミュート中はヘッダーアイコン (将来) を「斜線スピーカー」に変更する余地を残す (CSS の `.is-muted` を `body` に付与)。

## options 仕様

- 既存 `#opt-sound-enabled` / `#opt-sound-volume` / `#opt-sound-volume-out` を再利用。
- `#opt-sound-volume` の `step` は 0.05 のまま、表示は `Math.round(value*100)+"%"`。
- `sound_enabled === false` の間は `#opt-sound-volume` を `disabled` にし、視覚的にも灰色化。
- 子供モード時は最大値を 80% にする旨のヒント (`options_sound_volume_child_hint`) を表示 (新規 i18n)。
- 「テスト再生」ボタン (`options_sound_test`) を追加し、押下で `playPhaseTransition("work", settings)` を 1 回呼ぶ。Premium 不要。

## アクセシビリティ

- ミュート切替時の文言は `aria-live="polite"`。SR ユーザは「ミュートにしました / 解除しました」と把握できる。
- 視覚情報 (big-visual-timer の色変化) と音は冗長化された情報源。どちらかを失っても遷移は気付ける。
- 音量 0 = 音なし、`sound_enabled=false` = 音なし。両者の区別は SR には現れず、UI のチェック状態だけ。
- `prefers-reduced-motion: reduce` は本機能 (音) に影響なし。アニメ無効でも音は鳴る。
- `prefers-contrast: more` は本機能に影響なし。

## エッジケース

| ケース | 振る舞い |
| --- | --- |
| ブラウザがフォアグラウンドにない | offscreen ドキュメント経由なので再生は試みる。OS 側で抑制された場合は音だけ消える (通知は別経路で残る)。 |
| 連続 `skip` (1 秒以内に複数回) | `sound.ts` の 100ms デバウンスで 1 回だけ鳴る。 |
| `sound_volume === 0` で `sound_enabled === true` | offscreen 文書を作らず no-op。ストレージ上の意図 (将来 ON に戻す) は保持。 |
| 端末スリープ復帰直後の `handlePhaseEnd` | 遷移は完了するが、OS によっては音が鳴らないことがある (Chrome の制約)。失敗は静かに無視。 |
| 通知 OFF + 音 OFF | フェーズ遷移は popup 側の色変化のみで判別。`big-visual-timer` の責務で担保。 |
| 設定で `notification_enabled=false` のみ | 音は鳴る。両者は独立。 |
| Premium 解放 / 解除 | 影響なし (本機能は無料)。 |
| ストレージ未初期化 | `ensureDefaults()` 後に再生試行されるよう、background 側で `settings` を `get()` してから判定する (既存パターンどおり)。 |
| 子供モードで音量 100% を保存しようとした | options 保存時に `clampVolumeForMode(value, child_mode)` で 0.8 に丸める。次回読込時にスライダ表示も 0.8 になる。 |
| offscreen API 非対応の古い Chrome | `chrome.offscreen` の存在チェックで早期 return。例外を投げず no-op。 |

## マニフェスト/権限への影響

- `permissions` に `"offscreen"` を追加。
- `host_permissions` は追加しない (再生は同梱アセットのみ)。
- `web_accessible_resources` に `assets/chime.wav` を追加 (offscreen から `chrome.runtime.getURL` で参照するなら任意、`src=` で `chrome-extension://` URL を使うなら必要)。
- 同梱音声は CC0 もしくは自作 (帰属表記不要)。`legal/PRIVACY.md` には「音声は端末内のみで再生し、外部へ送信しない」旨を 1 行追記する余地を残す。

## i18n

新規メッセージキー (ja/en 両方追加。本タスクの設計段階ではキー一覧のみ確定、実体追加は T026 実装時):

- `popup_sound_on` (例: "サウンド ON" / "Sound on")
- `popup_sound_off` (例: "サウンド OFF" / "Sound off")
- `options_sound_test` (例: "テスト再生" / "Test sound")
- `options_sound_hint` (例: "フェーズの切り替わりに短い音が鳴ります。" / "A short chime plays at each phase change.")
- `options_sound_volume_child_hint` (例: "子供モードでは音量の上限が 80% になります。" / "Volume is capped at 80% in child mode.")

既存キー: `popup_mute` / `popup_unmute` / `options_sound_enabled` / `options_sound_volume` / `options_section_sound` はそのまま流用。

## 関連メモ

- [[design-big-visual-timer]]: フェーズ遷移の視覚情報。音と冗長化された情報源。
- [[design-child-mode]]: 子供モード時の音量上限 (0.8) を本機能で実装。UI 外観の差し替えは child-mode 側。
- [[design-break-reminder]]: 通知 (`chrome.notifications`) の発火と本機能 (音) は独立。両者 OFF でも視覚遷移は止めない。
- [[design-session-stats]]: 影響なし。
- [[storage]]: `Settings.sound_enabled` / `Settings.sound_volume` の真実。

## 受け入れ条件 (T026/T027 で検証)

- work → break / break → work / break → long_break / long_break → work の各遷移で短い音が 1 回鳴る (`sound_enabled && sound_volume > 0` のとき)。
- popup の `#toggle-mute` を ON にすると、その後の遷移で音が鳴らない。OFF に戻すと再び鳴る。
- options の音量スライダを 0 にすると音が鳴らない (offscreen 文書も生成されない)。
- options の音量スライダを 50% にすると、再生音の `audio.volume === 0.5` になる。
- options の「テスト再生」を押すと、現在の設定通りに 1 回再生される。`sound_enabled=false` のときは無音 (no-op)。
- 子供モードで `sound_volume=1.0` を保存しても、次回読込時に 0.8 にクランプされている。
- `reset()` では音が鳴らない。`skip()` でも遷移なら鳴る。
- `notification_enabled=false` でも音は鳴る (両者独立)。
- `chrome.offscreen` 非対応環境で例外を投げず、no-op で完了する。
- ja / en 両方で sound-mute 関連の文言が表示できる。
- 100ms 以内の連続 `skip` で音が 2 回鳴らない (デバウンス)。
