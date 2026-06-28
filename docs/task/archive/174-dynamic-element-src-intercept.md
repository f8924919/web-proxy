# 174 動的挿入要素の src 横取り（SW ギャップ離脱の解消）

- Issue: #174
- ブランチ: `bugfix/174-dynamic-element-src-intercept`
- 関連: クライアント側ナビ URL 堅牢化 #172（残課題） / 実行時リクエスト横取りシム #124 / アセット URL スキーム #100 / SRI 除去

## 背景・真因（方式B プローブで確定）

#172 後も YouTube で次が `/api/proxy/` を経由せず離脱:

- `/s/search/audio/*.mp3` … `<audio>.src =`（プロパティ代入）
- `/s/player/.../www-player.css` … `<link>.href =`（プロパティ代入）
- `/s/player/.../*.js`（base/offline/remote/miniplayer） … **`innerHTML` 等で `src` 付き生成した `<script>` を `appendChild`/`insertBefore` で挿入**（classic script・`initiatorType: script`）

`.src=`/`setAttribute` を経由しない（innerHTML 生成 → 挿入）経路があるため、**挿入メソッドの横取りが核**。サーバー側 `rewriteHtml` は初期 HTML のみ、SW は初回ロード未制御（claim 前）で、いずれも取りこぼす。

## 対応（包括・ユーザー選択）

`src/lib/proxy/rewrite.ts` の `REQUEST_INTERCEPT_HTML`（`<head>` 最先頭）に、要素のリソース属性書き換えを追加。判定は純粋関数 `buildElementSrcRewrite(tagName, attr, value, rel, pageUrl, swOrigin, basePath)`。

書き換え規則（サーバー側 `rewriteHtml` と同一）:

- `script/img/source/video/audio[src]` → `/api/proxy`（`buildRequestInterceptUrl`）
- `img/source[srcset]` → 候補ごとに `/api/proxy`（記述子保持）
- `link[href]`（rel が stylesheet/preload/modulepreload/prefetch のみ）→ `/api/proxy`
- `iframe[src]` → `/browse`（`buildClickNavDestination`）
- `script[src]` 書き換え時は `integrity`/`crossorigin` 除去

横取り経路（重ねがけ）:

1. 挿入メソッド（`appendChild`/`insertBefore`/`replaceChild`/`append`/`prepend`/`before`/`after`/`replaceWith`）— ノード＋子孫を委譲前に書き換え（主経路）
2. `src`/`href`/`srcset` プロパティ setter
3. `Element.prototype.setAttribute`
4. `MutationObserver` バックストップ（innerHTML 直挿入のベストエフォート）

`pg()`（#172）でターゲット復元を共有。既に proxy 枠（`null`）なら触らない（冪等・SW 非競合）。

## テスト

- `buildElementSrcRewrite`（純粋関数）: `tests/lib/proxy/rewrite.test.ts`（node）。
- 配線（挿入/ setter / setAttribute / MutationObserver）は jsdom（`tests/lib/proxy/rewrite.dom.test.ts`）で代表確認。最終は方式B で実測。

## 残課題・既知の制限

- 接続済みサブツリーへの `innerHTML` 直挿入は解析時フェッチが先行し MutationObserver 補正が再フェッチになり得る（実害は二重リクエスト）。
- 別オリジン iframe 内は当該フレームのシムが担う。CSS `url()`/`@import` は対象外。
- `googlevideo.com/videoplayback` 403（アンチボット・#73）は別系統で対象外。
