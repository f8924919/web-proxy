# #70 ブラウザバック中継: ヒューリスティック自動ティア昇格（崩れ/チャレンジ検出）

- **Issue**: [#70](https://github.com/f8924919/web-proxy/issues/70) ブラウザバック中継: ヒューリスティック自動ティア昇格（崩れ/チャレンジ検出）
- **ブランチ**: `feature/70-heuristic-auto-tier-promotion`
- **ステータス**: 進行中
- **関連**: 本体 #69（ブラウザバック中継）、egress IP は対象外 #73

## 目的

#69 は昇格トリガを明示 allowlist / env に限定した。allowlist は手動運用で未知サイトの崩れに追従できない。中継ティア（`proxyFetch`）の初回応答から「崩れ/チャレンジ」を検出し、自動でブラウザティアへフォールバック昇格できるようにする（allowlist の補助）。

## 方式（ユーザー確定）

- **検出シグナル**: `<noscript>` 主体 / チャレンジ語句（`enable javascript` / `enablejs` / `checking your browser` / `recaptcha` / Cloudflare 等）/ `403`・`503` ステータスのいずれか。空 body 単独は判定材料にしない。
- **再昇格抑止**: `host + path`（クエリ無視。loopGuard と同方式）のスライディングウィンドウ（既定 60 秒）で、同一 URL の二重取得を 1 回 / ウィンドウに制限。
- **有効化ゲート**: 専用 env `PROXY_BROWSER_AUTO_PROMOTE`（`true`/`1`/`on`、既定 OFF）。allowlist 優先、検出は補助。
- **対象**: `/browse` GET の `text/html` 応答のみ（POST はボディ再送不可で対象外、allowlist 既昇格・非 HTML も対象外）。
- **誤検知時**: 昇格後の `browserFetch` 失敗時は初回の中継応答へフォールバック（best-effort）。

## 受け入れ条件（Issue より）

- [x] 昇格判定を純粋関数として実装（HTML / ステータス / Content-Type を入力）— `shouldPromoteToBrowser`
- [x] `shouldUseBrowser`（#69）の allowlist と OR 合流（allowlist 優先、検出は補助）
- [x] 二重取得コストの上限・無限ループ防止（同一 URL 再昇格抑止）— `PromotionGuard`
- [x] 誤検知時の影響最小化（昇格は best-effort、失敗時は proxyFetch 結果へフォールバック）
- [x] 検出ロジックの単体テスト（崩れ/正常の代表的 HTML パターン）— `tests/lib/proxy/promotion.test.ts`
- [x] docs（spec/arch）先行更新

## 実装メモ

- 新規モジュール `src/lib/proxy/promotion.ts`: `autoPromoteEnabledFromEnv` / `shouldPromoteToBrowser`（純粋関数）と `PromotionGuard` / `promotionGuard`（インメモリ状態）。
- `src/app/browse/route.ts` の `relayBrowse` に `allowAutoPromote`（GET のみ true）を追加し、`text/html` 応答取得後に昇格判定 → `browserFetch` 再取得を挿入。
