# #168 実行時シムで navigator.sendBeacon を横取りし /gen_204 等の 404 を解消

対応 Issue: [#168](https://github.com/f8924919/web-proxy/issues/168)
ブランチ: `bugfix/168-sendbeacon-intercept`

## 背景

プロキシ経由表示で、JS が `navigator.sendBeacon()` で送るルート相対 beacon（Google の `/gen_204`・`/fp_204`・`/client_204` 等）が書き換えをすり抜け、プロキシ origin（例 `localhost:3000`）へ直撃して **404** になっていた。実行時リクエスト横取りシム（#124）は `window.fetch` と `XMLHttpRequest.prototype.open` のみ上書きし、`navigator.sendBeacon` を上書きしていなかったのが原因。

## 実測（方式B / `https://www.google.com/search?q=test`）

|                    | 失敗(>=400) | うち sendBeacon(ping) |
| ------------------ | ----------- | --------------------- |
| 修正前             | 40          | 24                    |
| 修正後（2 回計測） | 0 / 4       | **0 / 0**             |

- 修正後に残る最大 4 件（`/verify`・`/images`・`/xjs`・`/shared_dict`）は本 Issue のスコープ外。`/xjs` は JS が動的挿入する `<script>` 由来、`/verify` は `location`/`history` 由来のナビゲーション（フック不能・根本解は RBI [#72](https://github.com/f8924919/web-proxy/issues/72)）。
- 残存する pageerror（`Ona is not a function` 等）は `/xjs` 系 minified JS の実行時エラーで、本修正とは別系統（「JS ソース自体は書き換えない」設計境界）。

## 実装

- `src/lib/proxy/rewrite.ts` の `REQUEST_INTERCEPT_HTML` に `navigator.sendBeacon` 上書きを追加。第 1 引数 URL を既存の `buildRequestInterceptUrl` で `fetch`/XHR と同一規則で書き換え、`data` はそのまま委譲、戻り値の `boolean` も元実装の結果を返す。`navigator` を `this` として呼ぶ。`sendBeacon` 非対応環境では上書きしない。例外時は元挙動へフォールバック。
- テスト: `tests/lib/proxy/rewrite.dom.test.ts` に注入シムの配線テストを追加（元 `sendBeacon` をスタブし、ルート相対→`/api/proxy` 書き換え・自前ルート素通しを検証）。純粋ロジック（`buildRequestInterceptUrl`）の網羅は既存の `rewrite.test.ts` が担当。
- docs: `docs/spec/features/proxy.md` / `docs/arch/proxy.md` の §実行時リクエスト横取りシム に sendBeacon 対応を追記。

## 残課題（別 Issue 候補）

- `/xjs` 動的 `<script>` 挿入のルート相対 URL 書き換え（`createElement`/`src` setter 上書き等。侵襲的・要設計）。
