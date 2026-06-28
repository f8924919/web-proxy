# 172 クライアント側ナビゲーション URL の堅牢化（history API + Navigation API）

- Issue: #172
- ブランチ: `bugfix/172-history-state-intercept`
- 関連: 実行時リクエスト横取りシム #124 / sendBeacon #168 / パス反映ナビ #115 / クリック横取り #82 / RBI #72

## 背景・真因（方式B プローブで確定）

YouTube をプロキシ経由で開くと、ページは描画されるが**最終 URL がプロキシ origin ルート（`localhost:3000/`）へ化け**、以降 `/youtubei/v1/guide`・`/s/player/...` 等のルート相対リクエストが `/api/proxy/` を経由せず離脱していた。

Playwright `addInitScript` で history（instance/prototype 両方）・fetch・Navigation API を計測した結果：

- **history API 経由ではない**（pushState/replaceState 呼び出し 0 件）。
- 真因は **`location.replace('/')` 系（`location.*` 駆動）**。プロキシ配下では `/` が proxy origin ルートへ解決され、これが **Navigation API の `navigate` イベント（type=replace, dest=localhost:3000/, canIntercept=true）** として発火し、YouTube 自身のルーターが `intercept` → **同一ドキュメントのまま location が root に化け** browse コンテキストを喪失。

docs の「`location`/`history` API はフック不能」という記述は誤り（フック不能なのは `location.*` setter のみ。`history.pushState`/`replaceState` はメソッドで上書き可能。`location.*` の結果生じる navigation も Navigation API で捕捉可能）。

## 対応（3 段。最小・低リスクの組み合わせ）

`src/lib/proxy/rewrite.ts`：

1. **history.pushState / replaceState 上書き**（`CLICK_NAV_INTERCEPT_HTML`）。第 3 引数 url を `buildClickNavDestination` でパス反映ナビ形式へ書き換えて委譲。url 省略時は据え置き、state/title はそのまま、ナビゲーションは発生させない。
2. **Navigation API `navigate` 横取り**（純粋関数 `buildNavApiRedirect`）。プログラム起因（`!userInitiated`）・同一オリジンで枠を外れ、**補正先が現在地と異なる別ページ遷移**のみ `preventDefault` → reflect 形式へフルナビゲーション。**自己遷移（YouTube の `replace('/')` 等）は cancel しない**（`preventDefault` がサイトの `e.intercept()` 描画も巻き込み表示を壊すため）。Chromium 系のみ・feature-detect。
3. **リクエストシムの `pg()` フォールバック**（`REQUEST_INTERCEPT_HTML`）。注入時の reflect URL を `initPage` にキャッシュし、現 `location` が browse コンテキストを失っていればキャッシュを基準に fetch/XHR/sendBeacon を中継。自己遷移後も離脱しない核の安全網。

## テスト

- `buildNavApiRedirect`（純粋関数）: `tests/lib/proxy/rewrite.test.ts`（node）。
- history.pushState/replaceState 注入実行: `tests/lib/proxy/rewrite.dom.test.ts`（jsdom）。
- Navigation API 配線・`pg()` フォールバックは I/O 境界（[テスト方針](../testing/policy.md)）につき単体対象外。方式B で実測検証。

## 実測（方式B・`npm run debug:browser -- https://www.youtube.com/`）

|                                 | 修正前                               | 修正後                                     |
| ------------------------------- | ------------------------------------ | ------------------------------------------ |
| `youtubei/v1/guide`・`feedback` | ESCAPED（localhost 直下 404/誤 200） | **PROXIED**（`/api/proxy/...`）            |
| 最終 URL の browse コンテキスト | 喪失（root）                         | リクエストは `pg()` で中継継続（離脱せず） |
| ナビゲーションループ            | —                                    | 無し                                       |

## 残課題（#172 対象外・別系統）

- `/s/player/*.js`・`www-player.css`・`/s/search/audio/*.mp3` 等の**要素 src（script/link/media）のルート相対動的挿入**は本シム対象外で、Service Worker（初回ロードはギャップ）に依存。YouTube 左サイドバー／app-shell の描画はこれに律速される。→ 別 Issue **#174** として起票済み。
- `googlevideo.com/videoplayback` の 403（動画セグメント）はアンチボット/IP 起因（#73 と同種）。ブラウザティア・クリーン IP 前提で本質的に対象外。
- CSP report-only の相対 `report-uri` 404（ブラウザネイティブ送信のため JS シムでは横取り不可）。実害なしのノイズ。
