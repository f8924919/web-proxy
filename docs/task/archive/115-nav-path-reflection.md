# #115 ページ遷移の ?url= スキームとターゲット SPA のパラメータ名衝突（ナビのパス反映化）

- **Issue**: [#115](https://github.com/f8924919/web-proxy/issues/115)
- **ブランチ**: `feature/115-nav-path-reflection`
- **ステータス**: 進行中
- **種別**: 機能改修（ナビゲーション URL スキームのパス反映化）
- **関連**: #100（アセットのパス反映）/ #114（クエリ相対 ?q= の url= 欠落）/ #74（リバプロ配下のリダイレクト 404）
- **着手日**: 2026-06-22

---

## 背景・根本原因

旧ナビ形式 `/browse?url=<target>` では閲覧ページの `location.search` に proxy 専用パラメータ `url=<target>` が露出する。ターゲット SPA（DuckDuckGo）が `location.search` を読んでリンクを再構築すると `url=` を取り込み、ナビタブ（All/Images 等）が `/?url=<target>&ia=images` の壊れた形になる。またターゲット本来のクエリ（`q=test`）が `url=` 値の中に埋もれ SPA から見えない。

## PoC（実機・Playwright）

パス反映 `…/browse/https/duckduckgo.com/?ia=web&q=test` で配信すると、`location.search`=`?ia=web&q=test`（汚染ゼロ）、ナビタブが `/?ia=images&q=test&iax=images`（正常）になることを実証 → 案1（ナビのパス反映化）採用。

## 設計

- **正本**: `${BASE_PATH}/browse/<scheme>/<host>/<path>?<targetクエリ>`（#100 のアセット形式を `/browse/` 配下に適用）。`%2F`/非 ASCII の percent-encoding を保持（#111）。
- **後方互換**: GET `/browse?url=` は `buildBrowsePath` で組み立てたパス反映 URL へ **307 リダイレクト**。POST `?url=` は直接中継。
- **共通化**: `browseRelay.ts`（`relayBrowse`/`browseGuards`）を両ルートで共有。
- **rewriteHtml**: `browseUrl()` をパス反映形式（`buildBrowsePath`）へ。
- **クリック/フォーム横取り**: パス反映 location から target を復元し、パス反映形式で振り向け。共有 pure 関数 `browseNavPrefix`/`extractBrowseTarget`/`buildBrowseDest` を注入スクリプトに埋め込み。
- **SW**: `extractTarget` をパス反映ページ対応に（ランタイム root-relative サブリソースの target origin 解決）。
- **trailing-slash**: ターゲット root（`/`）が末尾スラッシュ URL を生み Next の 308 が BASE_PATH を落とす（#74 類）ため `next.config.mjs` に `skipTrailingSlashRedirect: true`。

## 実機検証（修正後）

- エントリ `?url=` → 307 → パス反映（curl 確認）
- ナビタブ Images クリック → `…/browse/https/duckduckgo.com/?ia=images&q=test&iax=images`（パス反映・正常） ✅
- 関連検索クリック → `…/browse/https/duckduckgo.com/?q=test+speed`（パス反映・正常） ✅

## 変更ファイル

- 新規: `src/lib/proxy/browsePath.ts` / `src/lib/proxy/browseRelay.ts` / `src/app/browse/[...slug]/route.ts`
- 変更: `src/app/browse/route.ts`（307 リダイレクト化）/ `src/lib/proxy/rewrite.ts`（browseUrl + 横取り）/ `public/sw.js`（extractTarget）/ `next.config.mjs`
- テスト: `browsePath.test.ts`（新規）/ `rewrite.test.ts` / `sw-intercept.test.ts`
- docs: `spec/features/proxy.md` / `arch/proxy.md`

## 受け入れ条件

1. [x] ナビ形式の組み立て/復元 pure 関数（`buildBrowsePath`/`targetFromBrowsePath`）・`%2F`/非 ASCII 保持
2. [x] GET `/browse/<scheme>/<host>/<path>` 中継・GET `?url=` は 307・案内ページ維持
3. [x] `<a>`/`<form>`/meta refresh がパス反映へ
4. [x] クリック/フォーム横取りがパス反映 location から target 復元・後方互換も動作
5. [x] DDG ナビタブ・関連検索クリックが正しく proxy 経由（実機）
6. [x] 既存挙動を退行させない（399 テスト green）
7. [x] spec/arch 更新（L73 方針反転）
8. [x] lint/型/テスト green

## 既知の制限（#115 で新規導入ではない）

SW `isProxyOwnPath`（[public/sw.js](../../public/sw.js)）は `/browse/`・`/api/proxy/` 接頭辞を自前ルートとして素通しする。ターゲットサイトが自身の `/browse/...` 配下にサブリソース（client fetch/XHR）を持つ場合、proxy origin 直下に解決され取りこぼす（旧 ?url= 方式でも同様に救済不可だった既存の挙動。クリック navigation は本タスクで `extractBrowseTarget` の scheme 検証により解決済み）。影響は限定的なため当面許容する。

## 進捗

- [x] PoC → 設計確定 → docs 先行 → 実装 → テスト green → 実機検証
- [x] verify-gate（verify 400 件 green / docs-check 反映 / evaluator PASS。退行 1 件を修正済み）
