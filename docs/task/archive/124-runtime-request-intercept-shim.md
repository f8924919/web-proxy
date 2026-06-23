# #124 初回ロードの相対/クロスオリジン サブリソースが SW 未制御で取りこぼされる

- **Issue**: [#124](https://github.com/f8924919/web-proxy/issues/124)
- **ブランチ**: `bugfix/124-runtime-request-intercept-shim`
- **ステータス**: 進行中
- **種別**: バグ修正
- **関連**: SW 横取り #100 / ブラウザバック中継 #69 / CSS 欠落 #120（発見元）/ hydration #123（別系統）
- **着手日**: 2026-06-23

---

## 結論（原因）

`PROXY_BROWSER_MODE=on` で news.yahoo.co.jp を開くと、初回ロードのランタイム fetch / XHR が取りこぼされ動的コンテンツが欠落する（「あなたにおすすめ」が「記事を表示できませんでした」）。

観測した失敗（#120 デバッグ中）:

```
404  /api/personalized-articles    （同一オリジン・ルート相対 fetch が proxy origin に着地）
404  /cb_pc.gif
net::ERR_FAILED  https://mhd.yahoo.co.jp/... / https://templa.yahooapis.jp/... / https://mempf.yahoo.co.jp/...（クロスオリジン XHR 直アクセス→CORS 失敗）
```

`public/sw.js` の横取りロジック（`rewriteRequestUrl`）自体は正しいが、**初回ロード時は `clients.claim()` 確立前に開始したサブリソース要求を SW が横取りできない**。ブラウザバック中継では配信 DOM がクライアントで動的データを再取得するため特に顕在化する。

## 設計方針（ユーザー確認済み）

- SW 非依存の **`fetch` / `XMLHttpRequest.prototype.open` 横取りシム**を `rewriteHtml` で `<head>` 最先頭へ注入する（既存の `document.domain` シム・click/form 横取りと同方式）。
- 書き換え規則は SW の `rewriteRequestUrl` と**同一**にし、振り向け先（同一オリジンの `/api/proxy/...`）が SW の自前ルート判定で素通しされるため**二重書き換えにならない**（冪等）。
- SW を置き換えず、初回ロードの制御ギャップを埋めるフォールバックとして併設する。

## 対象ファイル

- `src/lib/proxy/rewrite.ts`（純粋関数 `isProxyOwnPath` / `buildRequestInterceptUrl` 追加 + 横取りシム `<script>` を `<head>` 最先頭へ注入）
- `tests/lib/proxy/rewrite.test.ts`（純粋関数の単体テスト追加）
- `docs/spec/features/proxy.md` / `docs/arch/proxy.md`（設計反映）

## 受け入れ条件

- [ ] 初回ロードで SW 未制御により相対/クロスオリジン サブリソースが取りこぼされる挙動を再現・確認。
- [ ] `fetch` / XHR 横取りシムを `rewriteHtml` で `<head>` 最先頭へ注入（SW と同一規則で `/api/proxy` へ書き換え）。
- [ ] news.yahoo.co.jp のブラウザモードで 404 / ERR_FAILED が解消し動的セクションが表示されることを実機（debug:browser）で確認。
- [ ] 純粋関数（`isProxyOwnPath` / `buildRequestInterceptUrl`）の単体テストを追加し green。
- [ ] lint / 型 / テストが green。
