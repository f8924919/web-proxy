# #82 SPA クライアント側ナビゲーション離脱対策（クリック横取りの強化）

- **Issue**: [#82](https://github.com/f8924919/web-proxy/issues/82)
- **ブランチ**: `bugfix/82-spa-click-nav-intercept`
- **ステータス**: 進行中
- **関連**: 先行 #58（`<a>` クリック横取り初版）、本命の SPA 対応 #72（RBI）

## 背景

`yahoo.co.jp → news.yahoo.co.jp → 個別記事` で proxy から離脱する。`news.yahoo.co.jp` は React SPA で、サーバー書き換え済みの `<a href>` があっても **React の onClick ルーターがクリックを奪い `history.pushState` で遷移**するため離脱する。

## 方針（A 案不採用・実機検証済み）

- **A 案（History/location フック）は不採用**: `location.assign` / `location.href` setter / `window.location` はブラウザ仕様で改変不能（実機で `Cannot redefine property` 確認）。`history.pushState` のみ上書き可能だが、正当な SPA 内部更新まで full nav 化しリロードループを招く。
- **B 案（クリック横取り強化）で対応**: capture-phase ハンドラは React の onClick（バブル）より先に発火し、`stopImmediatePropagation()` で横取りを阻止できることを実機確認。これを用いて確実に proxy 経由フルナビゲーション化する。

## 受け入れ条件（Issue より）

- [ ] `buildClickNavDestination(href, pageUrl)` を拡張: 外部絶対(+プロトコル相対) / ルート相対・相対（現ターゲット base で再解決）/ 書き換え済み browse リンク（フルナビゲーション）/ 自前 UI・非 http・`#`・`url=` 欠落（null）。
- [ ] 注入ハンドラで `preventDefault` + `stopImmediatePropagation`、`#proxy-addressbar` 内は除外。
- [ ] スコープ外維持（修飾キー/中クリック/\_blank、defaultPrevented、location/history 直接呼び出し）。
- [ ] 単体テスト（各パターン）。
- [ ] docs（spec/arch）先行更新。

## 実装メモ

- `src/lib/proxy/rewrite.ts`: `buildClickNavDestination` / `CLICK_NAV_INTERCEPT_HTML`。
- 既存テスト（ルート相対/相対/プロトコル相対/書き換え済みリンクが null）は新仕様に合わせて更新する。
