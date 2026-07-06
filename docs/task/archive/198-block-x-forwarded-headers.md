# #198 非 GET 中継の X-Forwarded-Host 漏えい修正（note.com 障害画面）

- **Issue**: [#198](https://github.com/f8924919/web-proxy/issues/198)
- **ブランチ**: `bugfix/198-block-x-forwarded-headers`
- **ステータス**: 進行中
- **種別**: バグ修正
- **関連**: #27（origin / referer の遮断。今回はその趣旨を x-forwarded-\* 系へ拡張）
- **着手日**: 2026-07-06

## 事象と真因（実機確認済み）

プロキシ経由で note.com を開くと「ただ今障害が発生しております」（note.com 自身のエラー画面）が表示される。

1. Next.js（および前段リバースプロキシ）が受信リクエストへ `X-Forwarded-Host: <プロキシ自身のホスト>` を自動付与する。
2. 非 GET 中継の `relayRequestHeaders`（`src/lib/proxy/headers.ts`）の拒否リストに `x-forwarded-*` 系が無く、そのまま上流へ転送される。
3. note.com（Rails HostAuthorization 相当）が `X-Forwarded-Host` を検証し 403 `{"data":"Host is not allowed"}` を返す。
4. `POST /api/v3/graphql/auth`・`PUT /api/v2/ccd` の失敗で note.com フロントが障害画面へ差し替える。

裏取り: 直 curl で `X-Forwarded-Host` 付与時のみ 201→403 に変化。httpbin.org 宛て中継で上流に `X-Forwarded-Host: localhost:3000` が届くことを確認。GET/HEAD は許可リスト方式（`forwardableRequestHeaders`）のため影響なし。`relayRequestHeaders` の呼び出し元は `relayAsset.ts` の 1 箇所のみ。

## 実装方針

- `RELAY_BLOCKED_REQUEST_HEADERS` へ `x-forwarded-host` / `x-forwarded-for` / `x-forwarded-proto` / `x-forwarded-port` / `forwarded` / `x-real-ip` を追加（本事例で確認できた代表的なヘッダーに限定）。
- テストは `tests/lib/proxy/headers.test.ts` の拒否リスト `test.each` へ追記（大文字表記入力ケースを 1 つ含める）。
- docs: `docs/spec/features/proxy.md` §非 GET 中継のリクエストヘッダー転送 / §セキュリティ上の制約、`docs/arch/proxy.md` §relayRequestHeaders を更新。

## 進捗

- [x] デバッグ・真因特定（curl / Playwright / httpbin で実証）
- [x] Issue 起票（criteria-review の指摘を反映し受け入れ条件を更新）
- [x] docs 先行（spec / arch / task）
- [x] テスト先行（red 確認）
- [x] 実装 → green（全 802 テスト green・lint / typecheck 通過）
- [x] 検証: httpbingo.org 宛て中継で、注入した `X-Forwarded-Host` / `X-Real-IP` / `Forwarded` が上流へ届かないこと・`X-Requested-With` 等のカスタムヘッダーは転送維持されることを確認（2026-07-06）
- [x] 手動スモーク: code-server リバースプロキシ経由（`/proxy/3000/browse/https/note.com/`）のヘッドレス Chromium で note.com トップが障害画面ではなく正常表示、`POST /api/v3/graphql/auth` が 403→201 に回復（2026-07-06）
- [ ] verify-gate → PR
