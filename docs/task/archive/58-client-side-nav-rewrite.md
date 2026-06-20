# 58 JS 動的描画リンクのクライアント側ナビゲーション横取り

- 対応 Issue: #58
- ブランチ: `bugfix/58-client-side-nav-rewrite`
- ステータス: 進行中

## 背景

`www.yahoo.co.jp` トップの記事リンク（`news.yahoo.co.jp/articles/…`）は React がページ読み込み後にクライアント側で動的描画するため、サーバー側 `rewriteHtml`（初期 HTML を一度書き換えるだけ）の対象外。生 URL のまま残り、クリックするとトップフレームのナビゲーションが実サイトへ直行してプロキシから離脱する。SW はナビゲーション素通し＋別オリジンでスコープ外のため横取り不可。

実機（`npm run debug:browser`）で裏取り済み: トップを JS ハイドレーション後、生 `news.yahoo.co.jp/articles` リンク 35 本／書き換え済み 21 本、サーバー出力には生リンク 0 本。

## 設計方針（ユーザー確認済み）

`GET_FORM_INTERCEPT_HTML` と同方式で、純粋関数 `buildClickNavDestination(href, pageUrl)` を `toString()` 埋め込みし、`document` の `click`（capture）委任スクリプトを `<body>` 直後（GET フォーム横取りに続けて）へ注入する。

- **対象**: `closest('a[href]')` の href が **http(s) 絶対 URL のみ**横取り → `${BASE_PATH}/browse?url=<encoded>`。
- **BASE_PATH 保持**: `location.pathname`（=`${BASE_PATH}/browse`）を再利用。
- **スコープ外（ユーザー確認済み）**: 修飾キー / 中クリック / `target="_blank"`（新規タブはブラウザ標準挙動を尊重＝離脱は既知の制限）・`defaultPrevented`・相対/ルート相対・`location`/`history` API 経由の遷移。
- 自前リンク（`${BASE_PATH}/…`・`#`・`javascript:`）は http(s) 絶対 URL 条件で自然に除外。

## 関連 docs

- spec: [docs/spec/features/proxy.md §クライアント側ナビゲーションの横取り](../spec/features/proxy.md#クライアント側ナビゲーションの横取り)
- arch: [docs/arch/proxy.md §クライアント側ナビゲーション横取りスクリプト注入](../arch/proxy.md)

## 進捗

- [x] 調査・原因特定（実機裏取り）
- [x] docs 反映（spec / arch / index）
- [ ] テスト先行（`buildClickNavDestination` 純粋関数 + jsdom クリック委任）
- [ ] 実装 → green
- [ ] verify-gate
