# #201 React 全体 hydration によるアドレスバー削除の自己修復

- **Issue**: [#201](https://github.com/f8924919/web-proxy/issues/201)
- **ブランチ**: `bugfix/201-addressbar-self-heal`
- **ステータス**: 進行中
- **種別**: バグ修正
- **関連**: #108（fixed 化＋スペーサー）/ #137（注入 HTML のエスケープ）/ #123（ブラウザティア hydration・実害なし判定）/ #124（MutationObserver バックストップの前例）
- **着手日**: 2026-07-06

## 事象と真因（実機確認済み）

プロキシ経由の note.com で、表示から約 3 秒以内にアドレスバー `#proxy-addressbar` とスペーサーが DOM から消える。

- 削除スタックトレースを計測した結果、削除者は note.com の react-dom チャンク（`removeChild`）。
- note.com は Next.js App Router で、React がドキュメント全体を hydration する。`<body>` 直後に注入した SSR 出力に無いノードが hydration 不一致となり、クライアント側再レンダリングのフォールバックで body 直下を作り直す際に注入ノードが物理削除される。
- App Router 採用サイト全般で再現しうる（Pages Router は `#__next` 配下のみ hydration するため影響なし）。

## 実装方針（同一ノード再挿入の自己修復）

- `ADDRESS_BAR_HTML` の IIFE スクリプトで、バー・スペーサーのノード参照を保持し、`document.documentElement` を `MutationObserver`（`childList`+`subtree`。#124 バックストップと同型）で監視。document から外れたら同一ノードを現在の `document.body` 先頭へ再挿入し、直後にスペーサー高さをバー実高へ同期する。
- 同一ノード再挿入のため冪等（重複生成なし）・入力値保持・高さ同期リスナーのクロージャ維持。body ごとの差し替えにも `subtree` 監視で追随。回数上限なし。
- テストは `tests/lib/proxy/rewrite.dom.test.ts`（jsdom）の既存 MO テスト様式（`removeChild` → `setTimeout(0)` 待ち → 確認）。

## 進捗

- [x] デバッグ・真因特定（削除スタックトレースで react-dom を特定）
- [x] Issue 起票（criteria-review の指摘を反映: 同一ノード再挿入方式の明記・必須テストケース列挙・手動スモークの区別）
- [x] docs 先行（spec / arch / task。設計レビューは investigate 推奨 no のため省略）
- [x] テスト先行（red 確認: 専用ファイル `rewrite.addressbar.dom.test.ts`・6 ケース）
- [x] 実装 → green（全 808 テスト green・lint / typecheck 通過）
- [x] 手動スモーク（2026-07-06）: code-server 経由の note.com で表示後 10 秒間 200ms 間隔の全 51 サンプルでバー存在・高さ 43px、バー/スペーサー各 1 個・スペーサー高さ同期・CPU 最大 3.3% で高止まりなし。example.com でも全サンプル存在で回帰なし
- [x] verify-gate（verify / docs-check green。evaluator は条件付き PASS → spec §アドレスバー への追記をユーザー決定で実施し解消）
- [x] PR 作成（#202）
