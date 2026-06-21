# ブラウザバック中継（browser-backed fetch）PoC

対応 Issue: [#69](https://github.com/f8924919/web-proxy/issues/69)

> 本ファイルは作業中の**設計・進捗メモ**。受け入れ条件・仕様の正本は Issue #69 と `docs/spec/` / `docs/arch/`。

## 目的（要約）

URL 書き換え方式（`proxyFetch` + `rewriteHtml` + `public/sw.js`）が SPA・JS 必須ページで構造的に崩れる問題を補う。初回ナビゲーションだけをサーバー側インプロセス Playwright で実行し、JS 解決後の DOM を既存 `rewriteHtml` へ流す。明示 allowlist/env で対象サイトのみ昇格し、ブラウザ取得 Cookie をスコープ化発行して以降の `/api/proxy` へ引き継ぐ。

## 確定した設計判断（ユーザー確認済み）

| 論点             | 決定                                                                   |
| ---------------- | ---------------------------------------------------------------------- |
| 方式の方向       | 段階的折衷 → ブラウザバック中継（プリレンダ / セッションウォーミング） |
| ブラウザ実行場所 | **インプロセス Playwright（ローカル）**。本番実行場所は #71 で別途決定 |
| ティア昇格トリガ | **明示 allowlist / env のみ**。自動検出は #70                          |
| PoC ゴール範囲   | **Cookie セッションウォーミング込み**                                  |
| 対象             | `/browse` GET のみ（POST はスコープ外）                                |

## 用語の整理（重要）

既存の **方式A / 方式B**（`docs/setup.md` §8、#32/#34/#39）は**デバッグ用にブラウザが proxy を外から開く**手段。本機能（サーバーがブラウザでターゲットを内から取得する中継経路）とは直交した別物のため、**「方式C」とは呼ばず「ブラウザバック中継（browser-backed fetch）」**と呼ぶ。`scripts/debug-browser.mjs` の waitUntil/timeout の env 設定・検証・ベストエフォート出力（#39）、`context.route` 傍受は本機能が流用できる前例。

## 統合点（裏取り済み）

- `relayBrowse`（`src/app/browse/route.ts`）が `proxyFetch` を呼ぶ箇所をティア分岐させる。
- `proxyFetch` / `browserFetch` 共通契約 = `ProxyFetchResult { response, finalUrl }`（`src/lib/proxy/fetch.ts`）。
- SSRF: `isSsrfBlocked` / `assertSsrfAllowed` 相当を再利用（`src/lib/proxy/fetch.ts`）。`assertSsrfAllowed` は現状 module-private のため公開化が要る。
- Cookie: `sanitizeSetCookie`（スコープ化）→ `sanitizeHeaders` 経由で outHeaders に載れば、以降は `scopedCookieHeader` が現ターゲット分を上流転送（`src/lib/proxy/headers.ts`）。

## 想定する分割（実装方針メモ）

- `src/lib/proxy/browserFetch.ts`（新規）: ブラウザ起動・ライフサイクル・`page.goto`/待機/`page.content()`/`page.url()`、cookie 回収、SSRF 傍受。
- 純粋関数（単体テスト対象）: `shouldUseBrowser(url, config)`、cookie→Set-Cookie 変換、待機設定の構築。
- 実ブラウザ I/O はテスト対象外（[testing policy](../testing/policy.md)）。

## 未決・要検討（実装中に詰める）

- ブラウザ再利用 vs 都度起動、同時実行上限の具体値。
- 待機戦略の既定（`load` / `networkidle` / 追加 idle 待ち）と timeout 既定。
- 失敗時に `proxyFetch` へフォールバックするか、502 で返すか。
- env 名の確定（`PROXY_BROWSER_HOSTS` / `PROXY_BROWSER_MODE` 等）。

## フォローアップ

- #70 ヒューリスティック自動ティア昇格 / #71 本番実行基盤 / #72 RBI 調査スパイク / #73 アンチボット対策。

## 進捗

- [x] 設計検討・方式決定（ユーザー確認）
- [x] Issue 起票（#69 本体 + #70〜#73 フォロー）
- [x] ブランチ作成（`feature/69-browser-backed-fetch`）
- [x] docs 先行（spec / arch / 各 index / setup）
- [x] テスト先行（純粋関数・35 ケース）
- [x] 実装 → green（型 / lint / 256 テスト・フォーマット）
- [x] 検証ゲート（verify 手動 green / docs-check 修正済 / evaluator 10/10 PASS）
- [ ] PR 作成・マージ（ユーザー承認後）
