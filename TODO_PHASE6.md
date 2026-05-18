# Phase 6: 品質向上 TODO (focus-timer)

注意: TODO.md (Phase 1-5) は完成済、release/focus-timer.zip は申請準備済。
このフェーズは品質向上のみ、既存機能を壊さない。

- [x] T101: README.md に使用例と機能一覧を追加 (英日)
- [x] T102: src/ 配下の全 .ts/.js ファイルに JSDoc コメント追加
- [x] T103: ARIA ラベルを popup/options の全 button/input に追加 (アクセシビリティ)
- [x] T104: キーボード操作完全対応 (Tab navigation + Enter キー)
- [x] T105: ダークモード細部調整 (CSS variables の高コントラスト対応)
- [x] T106: 設定の export/import 機能 (chrome.storage.local → JSON)
- [ ] T107: i18n メッセージキー総点検、未使用削除 + ja/en 整合性チェック
- [ ] T108: chrome.alarms / chrome.tabs 等の API 呼び出しに try-catch 追加
- [ ] T109: manifest.json の description を _locales 経由で多言語化
- [ ] T110: tests/ ディレクトリに最低 10 個の単体テスト追加 (vitest)
- [ ] T111: docs/ARCHITECTURE.md にコンポーネント図 Mermaid 追加
- [ ] T112: GitHub Actions workflow (lint + build + test) を .github/workflows/ci.yml に
- [ ] T113: CHANGELOG.md (Keep a Changelog 準拠) 作成
- [ ] T114: src/ から console.log/debug を全削除 (本番ビルド)
- [ ] T115: dist/ 生成サイズの最適化 (vite config の minify 最適化)
