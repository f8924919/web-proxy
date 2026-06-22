# #108 プロキシ UI バーが body{height:100%} のサイトでスクロール時に消える

- **Issue**: [#108](https://github.com/f8924919/web-proxy/issues/108)
- **ブランチ**: `bugfix/108-addressbar-fixed-position`
- **ステータス**: 進行中
- **種別**: バグ修正
- **関連**: アドレスバー注入（`rewrite.ts` の `ADDRESS_BAR_HTML`）/ docs/arch/proxy.md §アドレスバー注入 / docs/spec/screens/browse.md §コンテンツエリア

---

## 原因（特定済み）

注入する UI バー（`#proxy-addressbar`）は `position: sticky; top:0` で実装されている。`sticky` 要素は**包含ブロック（親の `<body>`）の範囲内でしか張り付かない**。ターゲットサイトが `html, body { height:100% }` を指定していると body の高さが 1 ビューポート分に固定され、それより下へスクロールするとバーが body もろとも画面外へ流れて消える。

ipleak.net は `html{height:100%}` / `body{height:100%}` を持ちコンテンツが縦に長いため確実に再現する。DOM 削除・`document.write`・SPA ハイドレーションは原因ではない（素の SSR HTML、`index.js` の DOM 操作は特定要素の `.html()` 更新と非表示 iframe の append のみ）。

### 検証（Playwright・手動）

ipleak と同条件（`body{height:100%}` + 縦長コンテンツ）で再現・修正後を実測。

| 条件                                 | 初期                                                | 1500px スクロール後             |
| ------------------------------------ | --------------------------------------------------- | ------------------------------- |
| 修正前 `position:sticky`             | top:0                                               | **top:-830 → 画面外（消える）** |
| 修正後 `position:fixed` + スペーサー | top:0（content はスペーサー分押し下げ・重なりなし） | top:0（固定表示を維持）         |

> テスト方針上 E2E/UI スモークはスコープ外（[policy §2.4](../testing/policy.md)）のため、自動テストは `rewriteHtml` 出力マークアップに対するロジック層検証（fixed 指定・スペーサー・高さ同期スクリプトの存在）で行う。視覚挙動は上記 Playwright で手動確認。

## 修正方針

`#proxy-addressbar` を `position: fixed; top:0; left:0; right:0` に変更し、ターゲットの body 高さに依存せずビューポート上部へ常に固定する。コンテンツとの重なりは、バー直後に挿入するスペーサー `#proxy-addressbar-spacer` の高さをバーの実レンダリング高に同期（初期＋`resize`/`load`）して回避する。外部 CSS 依存なし（インラインスタイル）の方針は維持。

## 受け入れ条件（Issue #108）

- [ ] `#proxy-addressbar` を `position: fixed` 化しビューポート上部へ常に固定
- [ ] バー直後にスペーサーを挿入し、高さをバー実高に同期してコンテンツの重なりを回避
- [ ] ロジック層テスト（fixed 指定・スペーサー・同期スクリプトの存在）を追加
- [ ] 既存の注入挙動（GET フォーム横取り・クリックナビ横取り・SW 登録）に回帰なし
