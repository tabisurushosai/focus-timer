# TODO: 集中タイマー (focus-timer)

## Phase 1: 基盤セットアップ (T001-T010)
- [x] T001: package.json (devDeps: typescript, vite, @types/chrome; scripts: build, lint, package)
- [x] T002: tsconfig.json (target ES2020, strict, jsx none)
- [x] T003: vite.config.ts (Chrome 拡張用ビルド設定、entry: popup + background + content)
- [x] T004: manifest.json (V3, name は __MSG_appName__、description は __MSG_appDesc__、default_locale ja、icons 3サイズ、permissions は機能要件最小限)
- [x] T005: _locales/ja/messages.json (appName, appDesc, popup_*, options_* 全項目)
- [x] T006: _locales/en/messages.json (上記の英訳)
- [x] T007: icons/icon16.png, icon48.png, icon128.png (シンプルなデザイン、絵文字風 SVG → PNG 変換)
- [x] T008: src/i18n.ts (chrome.i18n.getMessage ヘルパ)
- [x] T009: src/background.ts (service_worker 雛形、onInstalled で初期化)
- [x] T010: legal/PRIVACY.md, legal/TERMS.md (個人情報非収集、外部送信なし明記)

## Phase 2: UI 基盤 (T011-T015)
- [x] T011: src/popup.html (基本レイアウト、i18n attr)
- [x] T012: src/popup.css (シンプル・アクセシブル、ダークモード対応)
- [x] T013: src/popup.ts (popup を起動時に表示、i18n 適用)
- [x] T014: src/options.html, options.ts (必要なら、設定UI)
- [x] T015: src/storage.ts (chrome.storage.local ラッパ、型付き)

## Phase 3: コア機能実装 (T016-T030 = 15タスク、上の features 5個を3タスクずつ分解)
- [x] T016: big-visual-timer — 設計
- [x] T017: big-visual-timer — 実装
- [x] T018: big-visual-timer — テスト・整合
- [x] T019: child-mode — 設計
- [x] T020: child-mode — 実装
- [x] T021: child-mode — テスト・整合
- [x] T022: session-stats — 設計
- [x] T023: session-stats — 実装
- [x] T024: session-stats — テスト・整合
- [x] T025: sound-mute — 設計
- [x] T026: sound-mute — 実装
- [x] T027: sound-mute — テスト・整合
- [x] T028: break-reminder — 設計
- [x] T029: break-reminder — 実装
- [x] T030: break-reminder — テスト・整合

## Phase 4: Premium ゲート (T031-T033)
- [x] T031: src/premium.ts (trial_start_ts 管理、is_premium / is_trial 判定関数)
- [ ] T032: Premium 機能の UI ゲート (無料: 基本機能のみ、Premium: 詳細統計/無制限)
- [ ] T033: src/upgrade.ts (Stripe Checkout URL 生成、購入後 chrome.storage に premium_unlocked=true)

## Phase 5: 仕上げ (T034-T035)
- [ ] T034: npm run lint 通過、npm run build 通過
- [ ] T035: release/focus-timer.zip 生成 (manifest + icons + _locales + dist/)
