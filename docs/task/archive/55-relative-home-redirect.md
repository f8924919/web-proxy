# /browse missing-url リダイレクトの内部オリジン漏えい修正

- 対応 Issue: #55
- ブランチ: `bugfix/55-relative-home-redirect`
- ステータス: 進行中

## 背景

`GET /browse` に `url` が無いとき、`Response.redirect(new URL(basePath + "/", req.url), 307)` が絶対 URL を Location に出していた。`req.url` はサーバ内部オリジン（localhost:3000）のため、code-server のポート転送 / リバースプロキシ越しで localhost が Location に漏れ、ブラウザが公開オリジンを離れて localhost へ遷移していた（ユーザー報告: 「localhost に転送される」）。

絶対 URL 生成はこの 1 箇所のみ。rewrite.ts / page.tsx / ループ案内ページは相対 BASE_PATH パスで漏れない。

## 修正

- `src/lib/proxy/response.ts` に `relativeRedirect(location, status=307)` を追加（相対 Location の Response を返す純粋関数）。
- `src/app/browse/route.ts` の missing-url 分岐を `relativeRedirect(\`${basePath}/\`, 307)` に変更。
- spec に §url 未指定時のホームリダイレクト（相対 Location の要件）を追加、arch GET フロー step2・モジュールツリーを更新。

## テスト

`tests/lib/proxy/response.test.ts` に `relativeRedirect` のテスト追加: Location が渡した相対パスのままで絶対 URL（`scheme://`）を含まないこと、status 既定 307・変更可。ルートハンドラ自体はテスト方針上エントリーポイント（対象外）。

## 受け入れ条件

Issue #55 のチェックリストに準拠。
