# #29 Cloudflare Access 背後でプロキシ自身の認証 cookie が落ちる問題の修正

対応 Issue: #29

## 背景

web-proxy 自身が Cloudflare Access（Zero Trust）の背後にあるホストで動く場合、Service Worker が
サブリソース要求を同一オリジンの `/api/proxy` へ振り向ける際の内部 `fetch` を `credentials: "omit"`
で行うため、プロキシ自身の Access 認証 cookie（`CF_Authorization`）が送られない。結果 Access が
未認証とみなしてログインページ（別オリジン）へ 302 し、SW の `fetch`（`redirect: "follow"`）が
クロスオリジンに着地して CORS / `Failed to fetch` が多発する。

`credentials: "omit"` は spec で意図的に選ばれた設計だが、本件はプロキシ自身の認証が落ちて
サイト全体が機能しない v1 リグレッション。完全な credentials 対応（#28）・サイト間 Cookie
アイソレーション（#25）・リダイレクト追従ハードニング（#26）は引き続き v2 課題とし、本タスクは
プロキシ自身のインフラ cookie 漏洩の遮断に限定する。

## 設計方針

1. **SW（[public/sw.js](../../public/sw.js)）**: 振り向け先は常に同一オリジンの `/api/proxy` なので
   内部 `fetch` を `credentials: "omit"` → `"same-origin"` にする。振り向け `fetch` 失敗時は未処理
   reject にせず `Response.error()` を返してグレースフルに処理する。
2. **上流転送ガード（[src/lib/proxy/headers.ts](../../src/lib/proxy/headers.ts)）**: `same-origin` 化で
   `/api/proxy` に届くプロキシ自身のインフラ認証 cookie（`CF_Authorization` / `CF_AppSession`）を、
   ターゲットへ転送する `Cookie` からデナイリストで除去する純粋関数 `stripInfraCookies` を追加し、
   `forwardableRequestHeaders` / `relayRequestHeaders` の両方で適用する。除去後に空なら `Cookie`
   ヘッダー自体を付けない。

## 検証メモ

- 関連: spec §CORS プリフライト対応 / §認証情報の転送、arch §Service Worker / §headers.ts
- テスト: `tests/lib/proxy/headers.test.ts` に `stripInfraCookies` と両関数の cookie 除去を追加
