# #100 プロキシ経由 SPA のランタイム相対 module import が 404

- **Issue**: https://github.com/f8924919/web-proxy/issues/100
- **ブランチ**: `bugfix/100-spa-runtime-relative-url`
- **ステータス**: 進行中

## 真因（再現で確証）

`debug:browser` で premium.yahoo.co.jp/entry/order/top をプロキシ経由再現し、SW 計装で確定:

- SW は介在している（`clientId` 取得済み＝ページ target 判明、素通しではない）。
- 失敗チャンク `/api/<chunk>.js` で SW の `req.referrer` は **EMPTY**。
- 機序: エントリ JS が旧 `/api/proxy?url=…` 経由で配信される → その `import.meta.url` のディレクトリは `…/api/` に固定 → Nuxt の相対 import `./BkYldQvH.js` が `…/api/BkYldQvH.js` に解決 → SW がターゲット **origin** 直下 `premium.yahoo.co.jp/api/BkYldQvH.js` へ誤振り向け（正は `/_main/nuxt/…`）→ 404・JSON・MIME エラー。

`<base>` 注入は module 解決（`import.meta.url` 基準）に効かないため不可。referrer 不在のため SW 単独の復元も不可。

## 方針（ユーザー確定: 完全パス反映 origin 込み）

アセット中継 URL を「クエリ方式 `/api/proxy?url=<encoded>`」から「パス反映 `/api/proxy/<scheme>/<host>/<path>`」へ変更。相対 import がブラウザ上でネイティブに正しく解決され、解決結果も自前ルート `/api/proxy/*` となり SW 素通し → ルート中継。

## 変更点

- spec: `docs/spec/features/proxy.md` §プロキシ URL スキーム（新設）・API 表・CSS・SW 表/節・CORS。
- arch: `docs/arch/proxy.md` モジュール構成・route・SW・rewrite。
- 実装: `src/lib/proxy/proxyPath.ts`（新・純粋関数 `buildProxyPath`/`targetFromProxyPath`）、`src/lib/proxy/relayAsset.ts`（中継共通化）、`src/app/api/proxy/[...slug]/route.ts`（新）、`src/app/api/proxy/route.ts`（後方互換に縮退）、`src/lib/proxy/rewrite.ts` `assetUrl`、`public/sw.js` `toProxy`。
- テスト: `tests/lib/proxy/proxyPath.test.ts`（新）、`rewrite.test.ts`/`rewrite.dom.test.ts`/`sw-intercept.test.ts` 更新。

## 受け入れ条件

- [x] ランタイム相対 import アセット（動的 import JS・CSS）がターゲットのパス文脈で正しく解決され 404 にならない。（`debug:browser` 実機再現で premium の Nuxt チャンク 58 件 + CSS が全て 200。パス反映形式 `/api/proxy/https/premium.yahoo.co.jp/_main/nuxt/…` で着地）
- [x] premium.yahoo.co.jp で `Failed to fetch dynamically imported module` / CSS MIME エラーが解消（修正後の実機再現で当該エラー消滅。残る console は hydration mismatch・preload 警告でターゲット側由来の良性）。
- [x] 旧 `?url=` 後方互換が維持される（`route.ts` は `relayAsset` へ縮退して維持）。

## 既知の軽微制約

- `targetFromProxyPath` は生 `req.nextUrl.pathname`（WHATWG URL の percent-encoded 形）から復元する前提。通常のアセットパスは ASCII で問題ないが、`%2F` や非 ASCII を含む特殊なパスは将来の裏取り対象（実機 E2E は ASCII パスで確証済み）。
