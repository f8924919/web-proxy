# #34 方式B（headless debug）で BASE_PATH 付き sw.js / リンクが 404 になる問題の修正

対応 Issue: #34

## 背景

#32 で導入したヘッドレスデバッグ（方式B、`npm run debug:browser`）でプロキシ経由ページを開くと、
console に `A bad HTTP response code (404) was received when fetching the script.` が出る。

原因は Service Worker 登録（[src/lib/proxy/rewrite.ts](../../src/lib/proxy/rewrite.ts) の `SW_REGISTER_HTML`）が
`${BASE_PATH}/sw.js`（例 `/proxy/3000/sw.js`）を取得しようとするのに対し、方式B が
`http://localhost:3000` を直叩きするためリバースプロキシ（code-server）のプレフィックス除去を
経由せず、dev サーバで 404 になること。製品本体（方式A / 実デプロイ）の不具合ではなく、
方式B がリバースプロキシのプレフィックス除去を再現していないことに起因する。

再現（裏取り済み、`.env.local`: `NEXT_PUBLIC_BASE_PATH=/proxy/3000`）:

| アクセス                 | 結果                |
| ------------------------ | ------------------- |
| `GET /sw.js`             | 200                 |
| `GET /proxy/3000/sw.js`  | 404                 |
| `/browse` 注入の登録パス | `/proxy/3000/sw.js` |

## 設計方針（採用: Issue の方針2）

方式B（[scripts/debug-browser.mjs](../../scripts/debug-browser.mjs)）が、リバースプロキシの
プレフィックス除去を肩代わりして方式A を忠実に再現する。

1. `.env.local` の `NEXT_PUBLIC_BASE_PATH` を読み（`DEBUG_BROWSER_BASE_PATH` で上書き可）、
   方式A と同じく **プレフィックス込みの URL**（`…/proxy/3000/browse?url=…`）でページを開く。
   これにより SW スコープ（`${BASE_PATH}/`）がページを覆い、ページ内リンク・サブリソースも
   方式A と同じパスで解決される。
2. 同一オリジンへの BASE_PATH 付きリクエストを Playwright の `page.context().route` で横取りし、
   プレフィックスを除去して dev サーバへ中継する（Service Worker スクリプト取得も対象）。

製品コード（`rewrite.ts` / `public/sw.js`）には手を入れない（影響範囲を最小化）。

## 検証メモ

- 再現・修正確認は `npm run debug:browser -- https://example.com` を実体実行。
  修正後 console エラーが消え（404 解消）、ページは `…/proxy/3000/browse?…` で 200。
- Playwright で SW 登録成功を確認（scope `http://localhost:3000/proxy/3000/`、
  controller scriptURL `…/proxy/3000/sw.js`）。BASE_PATH 付きホームリンク遷移も 200。
- 関連 docs: [docs/setup.md](../setup.md) §8.3（方式B の BASE_PATH 再現）。
- テスト方針上、`debug-browser.mjs` はエントリーポイント（スクリプト）でテストスコープ外
  （[docs/testing/policy.md](../testing/policy.md) §1）。検証は実体実行で行う。
