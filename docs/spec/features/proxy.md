# プロキシ機能仕様

[← 目次](../index.md)

**関連アーキテクチャ**: [プロキシシステム アーキテクチャ](../../arch/proxy.md)

---

## 概要

ユーザーのブラウザに代わり、Next.js サーバーがターゲットサイトへ HTTP/HTTPS リクエストを送信し、レスポンスを中継する機能。

---

## リクエストフロー

```
ブラウザ
  │
  │ GET /browse?url=<encoded>            （1. ページ要求）
  ▼
Next.js サーバー
  │  SSRF チェック → fetch(target_url)  （2. ターゲットへ中継）
  ▼
ターゲットサイト
  │
  │ レスポンス（HTML / CSS / 画像 / JS） （3. レスポンス返却）
  ▼
Next.js サーバー
  │  HTML / CSS 書き換え・ヘッダー処理  （4. 変換）
  ▼
ブラウザ                                 （5. 変換済みコンテンツを表示）
```

---

## API エンドポイント

| メソッド | パス                       | 役割                                                                                                              |
| -------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `GET`    | `/browse?url=<encoded>`    | アドレスバー付きの閲覧ページ（HTML を Server Component でレンダリング）                                           |
| `POST`   | `/browse?url=<encoded>`    | フォーム POST 送信の中継（リクエストボディと `Content-Type` をターゲットへ転送。詳細は [§POST 中継](#post-中継)） |
| `GET`    | `/api/proxy?url=<encoded>` | 静的アセットの透過中継（CSS・画像・JS をそのまま返す）                                                            |

### `url` 未指定時の案内ページ（GET）

`GET /browse` に `url` が無い場合（GET フォーム横取りの取りこぼし・`location`/`history` 駆動の JS ナビゲーションでの `url` 喪失・`/browse` への直接遷移など）は、**アドレスバー付きの案内ページ（HTTP 200）をその場で返す**（自動遷移を含まない）。ユーザーはアドレスバーに URL を入力して続行できる。

- **リダイレクトしない理由（#74）**: 以前はホーム（`${BASE_PATH}/`）へ 307 リダイレクトしていたが、リバースプロキシ（code-server のポート転送 `/proxy/3000`）配下では戻り先が **404** になっていた（Next は basePath 未使用でアプリのホーム実体は `/`。`/proxy/3000/` が末尾スラッシュ正規化で `/proxy/3000` に落ち 404）。リダイレクトを廃し、`/browse`（リバースプロキシが正しくプレフィックスを剥がす経路）で 200 ページを直接返すことでこの 404 を解消する。内部オリジン漏えい防止（旧 #55 の相対 `Location` 要件）は、そもそもリダイレクトを行わないため不要になる。
- **案内ページの導線**: 既存のアドレスバー（`#proxy-addressbar`）を再利用する。フォーム submit は `${BASE_PATH}/browse?url=<入力>` へ遷移する（正しく解決される経路）。meta refresh / location 自動遷移は含めない。
- **引き金（スコープ外）**: `url` 喪失の主因の一つは、Google 等の `location.assign` / `history` API による JS 駆動ナビゲーション（[§クライアント側ナビゲーションの横取り](#クライアント側ナビゲーションの横取り)の対象外）。本節はその場合に 404 ではなく案内ページを見せる対症であり、横取りの拡張は別課題。
- `POST /browse` の `url` 欠落・不正は、案内ページではなく **400** を返す（[§POST 中継](#post-中継)）。

---

## HTML 書き換え

### 使用ライブラリ

**`node-html-parser`** を採用する。

- 依存ゼロで軽量・高速
- 属性ベースの書き換えが素直に書ける（cheerio より軽量）

### 書き換えルール

相対パスはターゲットサイトのオリジンを基準に絶対 URL へ変換してからエンコードする。

| 対象タグ / 属性 | 遷移先ルート               | 理由                                                     |
| --------------- | -------------------------- | -------------------------------------------------------- |
| `<a href>`      | `/browse?url=<encoded>`    | リンク先もブラウズ画面で開く                             |
| `<form action>` | `/browse?url=<encoded>`    | フォーム送信もプロキシ経由（GET は下記スクリプトで補完） |
| `<img src>`     | `/api/proxy?url=<encoded>` | 透過中継（UI 不要）                                      |
| `<link href>`   | `/api/proxy?url=<encoded>` | 透過中継                                                 |
| `<script src>`  | `/api/proxy?url=<encoded>` | 透過中継                                                 |

### サブリソース整合性（SRI）属性の除去

`<script src>` を `/api/proxy?url=...` へ書き換えると、ブラウザが実際に取得するのは**プロキシが中継したレスポンス**になる。元の `src` に `integrity`（SRI）属性が付いている場合、中継レスポンスは元 URL のバイト列と一致する保証がなく（ヘッダーサニタイズ・エンコーディング差異等）、**SRI ハッシュ不一致でスクリプトの実行がブロック**される。これを防ぐため、`src` を書き換える `<script>` からは `integrity` 属性を除去する。

- **対象**: `src` を書き換える `<script src>`。同時に `crossorigin` 属性も除去する（書換後は同一 origin の `/api/proxy` 経由となり、CORS モード指定が不整合・不要になるため）。
- **対象外**: `src` を持たないインライン `<script>`、および `img` / `link` 等の他タグ（現状 SRI の実害が観測されていないため最小限に留める）。
- **背景**: Google の enable JavaScript インタースティシャル等、SRI 付きスクリプトでチャレンジ JS をロードするサイトで、`solveSimpleChallenge is not defined` 等の未定義エラーを誘発し得る要因の一つ（Issue #67 / 調査 #52）。

### meta refresh の書き換え

`<meta http-equiv="refresh" content="<遅延>;url=<TARGET>">` の `url` を `<a href>` と同様に `/browse?url=<encoded>` へ書き換える。これを行わないと、`url=/...`（ルート相対）の meta refresh が、閲覧ページ（`…/browse?url=…`）ではなく**プロキシ自身のオリジン直下**へ解決され、プロキシから離脱してしまう（例: `<meta http-equiv="refresh" content="3;url=/login">` のような遅延付き自動遷移）。

- **判定**: `http-equiv` の値は大文字小文字を無視して `refresh` と一致するものを対象とする。
- **解析**: `content` を `<遅延>;url=<TARGET>` として解釈し、`url=` の前後空白・大文字小文字・クォート（`'` / `"`）を許容する。遅延値はそのまま保持する。
- **書き換え対象**: `url=` が示すターゲットを `baseUrl` 基準で絶対 URL に解決し、http/https に解決される場合のみ `/browse?url=<encoded>` へ書き換える（`<a href>` と同じ `browseUrl()` の挙動に準拠。http(s) 以外はそのまま）。
- **対象外**: `url` を持たない純粋な遅延 refresh（例 `content="5"`、自ページ再読み込み）は書き換えず素通しする。

> **制限**: パーサ（`node-html-parser`）は `<noscript>` の内側を生テキストとして扱うため、**`<noscript>` 内の meta refresh は書き換えられない**。JS 有効ブラウザは `<noscript>` 内容を無視するため実害はないが、この書き換えは**プロキシオリジンへの離脱防止が目的**であり、Google 検索の「enable JavaScript」インタースティシャル（meta refresh が noscript 内・実駆動は JS の自己再ナビゲーション）による無限ループは**本書き換えの対象外**である。この無限ループ自体は別途 [ナビゲーションループの検出](#ナビゲーションループの検出enablejs-対策) で検出し、案内ページへ切り替えて停止させる。

### inline CSP（meta）の除去

レスポンスヘッダーの `Content-Security-Policy` は[ヘッダー処理](#レスポンスヘッダー処理)で除去するが、HTML 内に `<meta http-equiv="Content-Security-Policy" content="...">` で**インライン指定された CSP** はヘッダーサニタイズでは消せない。これが残ると、`rewriteHtml` が注入する各種スクリプト（アドレスバー・GET フォーム横取り・クリック横取り・SW 登録・`document.domain` シム。いずれも nonce 無し）や、`/api/proxy` へ書き換えた `src` が CSP 違反で**ブロック**され得る。これを防ぐため、`rewriteHtml` は inline の CSP meta を除去する。

- **判定**: `http-equiv` の値を大文字小文字を無視して照合し、`content-security-policy` に一致する `<meta>` を除去する。
- **対象外（素通し）**: `Content-Security-Policy-Report-Only` は実際のブロックを行わずレポートのみのため除去しない（`http-equiv` が `content-security-policy-report-only` のものは残す）。
- **対象外**: `<meta http-equiv="refresh">` 等、CSP 以外の meta は影響を受けない。
- **背景**: A1（SRI 属性除去）と同じく、注入スクリプトや書換 src のブロックを防ぐ汎用堅牢化（Issue #67 / 調査 #52）。

### GET フォーム送信の横取り

`<form action>` を `/browse?url=<encoded>` に書き換えても、**GET フォームの送信ではブラウザが action URL のクエリ文字列（`?url=...`）を破棄し、フォーム項目で置き換える**ため `url` が消失する。結果 `GET /browse?<form 項目>`（`url` 無し）となり、[ブラウズ Route Handler](../../arch/proxy.md#route-handler-srcappbrowseroutets) の `url` 未指定分岐が[案内ページ（HTTP 200）](#url-未指定時の案内ページget)を返してしまい、フォームの送信先（検索結果など）へ遷移できない（POST はボディで送るため影響を受けない）。

これを補うため、`rewriteHtml` は閲覧ページの `<body>` 直後（アドレスバー・SW 登録に続けて）に **GET フォーム送信を横取りするスクリプト**を注入する。挙動は以下のとおり。

| 条件                | 処理                                                                                                                  |
| ------------------- | --------------------------------------------------------------------------------------------------------------------- |
| GET フォームの送信  | `submit` を `preventDefault` し、ターゲットのクエリにフォーム項目をセットして `/browse?url=<再エンコード>` へ遷移する |
| POST フォームの送信 | 横取りせず素通し（action のクエリが破棄されないため従来通り機能する）                                                 |

- **ターゲットの復元**: 送信フォームの `action`（書き換え済み `…/browse?url=<target>`）から `url` パラメータを取り出してターゲットとする。`action` に `url` が無い（=`action` 属性なしのフォーム等）場合は、閲覧ページ自身の URL（`window.location`）の `url` パラメータをフォールバックに使う。
- **クエリの載せ替え**: 復元したターゲットの**クエリ全体**をフォーム項目（`FormData`）で置き換える。これは GET フォーム送信時のブラウザ本来の挙動（action のクエリを破棄してフォーム項目に差し替え）をプロキシ経由で再現するもの。
- **BASE_PATH の保持**: 遷移先は `action`（または `window.location`）の**パス部をそのまま再利用**するため、リバースプロキシのパスプレフィックス（`BASE_PATH`、例 `/proxy/3000`）込みの `…/browse` パスが保持される。
- **動的フォーム対応**: `document` への `submit` イベント委任（キャプチャ）で捕捉するため、JS が実行時に追加したフォームにも効く。
- **`form.submit()`（プログラム送信）の捕捉（#78）**: `HTMLFormElement.prototype.submit()` は `submit` イベントを**発火しない**ため、上記のイベント委任では捕捉できない（例: Google 検索は `form.submit()` で送信する）。これを補うため、`HTMLFormElement.prototype.submit` を**オーバーライド**し、同じ振り向けロジック（`buildGetFormDestination`）を適用する。`form.submit()` 呼び出し時点では action に `?url=<target>` が残っているため正しい URL を復元できる。GET でない／復元不可（`buildGetFormDestination` が `null`）／自前アドレスバーのフォーム、および例外時は**元の `submit` をそのまま呼ぶ**（挙動を変えない）。`requestSubmit()` は `submit` イベントを発火するため、イベント委任側で従来どおり捕捉する（オーバーライド不要）。
- **自前 UI の除外**: プロキシ自身のアドレスバー（`#proxy-addressbar` 内のフォーム）は独自の `onsubmit` で遷移を行うため、横取り対象から除外する（横取りすると入力 URL が無視され得る）。イベント委任・`submit()` オーバーライドの双方で除外する。
- **対象は GET のみ**: POST / その他メソッドは介入しない。GET フォーム以外の遷移は SW（下記）やサーバー側書き換えが担当する。
- **スコープ外**: フォームを介さない純粋な JS ナビゲーション（`location.assign` / `history.pushState` で完成済み URL へ直接遷移する経路）は引き続き対象外。

### クライアント側ナビゲーションの横取り

`rewriteHtml` の `<a href>` 書き換え（[書き換えルール](#書き換えルール)）は**サーバーが受信した初期 HTML を一度書き換えるだけ**で、JS（React 等）が**ページ読み込み後に動的描画した `<a href>`** は対象外となる。これらは生のターゲット URL（例 `https://news.yahoo.co.jp/articles/…`）のまま残り、クリックするとトップフレームのナビゲーションが**実サイトへ直行してプロキシから離脱**する。SW はナビゲーション（`request.mode === "navigate"`）を素通しし、かつ遷移先は別オリジンで SW スコープ外のため横取りもできない（[§Service Worker](#service-worker-による実行時リクエスト横取り)）。JS 主導でリンクを描画する SPA 系サイト（例 `www.yahoo.co.jp` トップのニュース記事リンク）で顕在化する。

さらに、SPA（React 等）は `<a>` クリックを **自前の onClick ルーターで横取りし、`history.pushState` で実サイトのパスへ遷移**させる（例 `news.yahoo.co.jp` トップ → 個別記事）。サーバー書き換え済みの `href` があっても、ルーターがクリックを奪うとプロキシから離脱する。`location` / `history` API 自体はブラウザ仕様で改変できず（`location.assign` / `location.href` setter / `window.location` はいずれも上書き不能。[#82](https://github.com/f8924919/web-proxy/issues/82) で実機確認）フックでは防げないため、**クリックの主導権を奪う**方式で対処する。

これを補うため、`rewriteHtml` は閲覧ページの `<body>` 直後（GET フォーム横取りに続けて）に **クリックによるナビゲーションを横取りするスクリプト**を注入する。`document` への `click` イベント委任（**キャプチャ**）で捕捉するため、JS が実行時に追加したリンクにも効き、かつ SPA ルーターの onClick（バブル）より**先に**発火する。

| 条件                                                               | 処理                                                                                                                                       |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `<a>`（祖先含む）への通常クリックで遷移先が proxy 中継対象（下記） | `preventDefault` + **`stopImmediatePropagation`**（SPA ルーターの横取りを阻止）し、`${BASE_PATH}/browse?url=<…>` へ `location.href` で遷移 |
| 上記以外（下記スコープ外）                                         | 横取りせず素通し                                                                                                                           |

振り向け先は純粋関数 `buildClickNavDestination(href, pageUrl)` が決める。クリックされた `<a>` の `href` を現在の閲覧ページ URL を基準に解決し、次のとおり中継先を組み立てる（`null` なら素通し）。

- **外部オリジンの絶対 URL**（`http(s)://…`・プロトコル相対 `//host/…` を含む）: `${BASE_PATH}/browse?url=<encodeURIComponent(絶対URL)>` へ振り向ける。
- **ルート相対 / 相対 URL**（`/articles/…`, `foo/bar`）: ブラウザ既定では proxy オリジン直下へ解決され離脱するため、**現在の閲覧ページの `url=` パラメータ（＝現ターゲット）を基準に解決し直し**、その絶対 URL を `…/browse?url=` へ振り向ける。
- **既に書き換え済みの proxy browse リンク**（同一オリジン・同一 `…/browse` パス）: その URL へ**フルナビゲーション**させる（`location.href` で遷移）。これにより SPA ルーターがクリックを奪って `history` 遷移する前に、確実に proxy 経由で読み込み直す。
- **BASE_PATH の保持**: 遷移先は現在の閲覧ページ URL（`window.location.pathname`＝`${BASE_PATH}/browse`）の**パス部をそのまま再利用**し `?url=` を載せ替える（GET フォーム横取りと同方式）。
- **`<a>` の探索**: クリック対象から祖先方向へ `closest('a[href]')` で最寄りの `<a href>` を探す（リンク内の子要素クリックにも効く）。

- **スコープ外（横取りしない）**:
  - **自前 UI**: プロキシのアドレスバー（`#proxy-addressbar` 内のリンク＝「ホーム」等）は除外する（自前導線を壊さない）。
  - **修飾キー付き / 中クリック / `target="_blank"`**: `Ctrl` / `⌘`(meta) / `Shift` / `Alt` 付きクリック・中クリック（補助ボタン）・別タブで開くリンクは素通しし、ブラウザ標準の新規タブ挙動を尊重する。**新規タブで開いた場合はプロキシを離脱する**（既知の制限）。
  - **既定動作が抑止済みのクリック**（`event.defaultPrevented`）: 他ハンドラが処理済みなら介入しない。
  - **`#` 同一ページアンカー・非 http スキーム**（`javascript:` / `mailto:` / `tel:` / `data:` 等）・`url=` が無い閲覧ページ上の相対リンク: 対象外（`null`）。
  - **`location` / `history` API 経由の直接遷移**: リンククリックを伴わない `location.assign` / `history.pushState` 等の純粋な JS 駆動遷移は依然として対象外（ブラウザ仕様上フック不能。完全対応は RBI [#72](https://github.com/f8924919/web-proxy/issues/72)）。

> **トレードオフ**: 本方式はリンククリックの主導権をプロキシが握るため、**同一サイト内の SPA クライアントルーティング（部分描画）も全てフルナビゲーション（proxy 経由の再読み込み）になる**。プロキシ配下では SPA のクライアント描画はいずれにせよ正しく動かないため、フルナビゲーション化は離脱を防ぐうえで許容する設計とする。

### `document.domain` ドメインガードの無効化

一部サイトは、自オリジン外での実行を検知するために **`document.domain` を正規表現で検査**し、マッチしない場合にトップフレームを実サイトへリダイレクトするドメインガードを持つ（例: Yahoo の `yjsecure.js` が `document.domain` を `/^(.+\.)?yahoo(\.co|-labs)?\.jp$/` で検査し、外れると `www.yahoo.co.jp` へ遷移させる）。プロキシ配下では `document.domain` がプロキシのホスト名（例 `localhost`）になるためガードが誤発火し、`news.yahoo.co.jp` などがプロキシ画面に留まらず実サイトへ飛んでしまう。

これを防ぐため、`rewriteHtml` は **`document.domain` がターゲットのホスト名を返すよう見せかけるシム `<script>`** を注入する。

| 項目         | 仕様                                                                                                                                                                                                                   |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 見せかける値 | ターゲット URL のホスト名（例 `news.yahoo.co.jp`）。`baseUrl` から導出する                                                                                                                                             |
| 実装方式     | `Document.prototype.domain` の getter をホスト名返却に上書きする（`document.domain` への代入は一部オリジンで禁止され得るため不採用）。例外は握り潰す                                                                   |
| 注入位置     | **`<head>` 最先頭**（他のページ内スクリプトより先に実行させるため）。ガードスクリプトは `<head>` 段階で動的挿入され得るため `<body>` 直後では間に合わない。`<head>` が無ければ `<html>` 直後、それも無ければ文書先頭へ |

- **スコープ外**: `location.hostname` / `location.href` など `location` 全体を偽装する汎用シムは対象外。本仕様は `document.domain` ベースのガード無効化に限定する。

---

## POST 中継

`/browse` は `GET` に加えて **`POST`** を受け付け、フォーム POST 送信をターゲットへ中継する。

### 経路

`<form action>` は `rewriteHtml` によりメソッドを問わず `…/browse?url=<target>` へ書き換えられる（[HTML 書き換え](#html-書き換え)）。POST フォームは GET フォームと異なり**ブラウザが action のクエリ（`?url=…`）を破棄しない**ため、追加の横取りスクリプトなしに `POST …/browse?url=<target>` として POST ハンドラへ届く（GET フォーム横取りスクリプトは非 GET を素通しする）。`action` 属性を持たない POST フォームは閲覧ページ自身（`/browse?url=<target>`）へ送信されるため、同じく正しいターゲットへ中継される。

### 転送内容

| 項目             | 扱い                                                                                                                                     |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| メソッド         | `POST` をターゲットへそのまま転送する                                                                                                    |
| リクエストボディ | `req.body`（`ReadableStream`）をそのままターゲットへ流す。`ReadableStream` をボディに用いるため `fetch` には `duplex: "half"` を付与する |
| `Content-Type`   | リクエストの `Content-Type` を転送する（`application/x-www-form-urlencoded` / `multipart/form-data` の境界情報を維持するため）           |
| レスポンス       | `Content-Type` が `text/html` なら GET と同様に `rewriteHtml` で書き換える。非 HTML はそのまま中継                                       |

SSRF チェック・レート制限（`/browse` は `pageRateLimiter`）・ステータスコードの中継・レスポンスヘッダーのサニタイズは GET と共通の処理を用いる。`url` パラメータが欠落・不正な POST は **400** を返す（GET の案内ページ（200）とは異なる）。

POST 時もリクエストの `Cookie` / `Authorization` を転送する（[§認証情報の転送](#認証情報の転送cookie--authorization)）。

### スコープ外（本機能では扱わない）

- **フォーム POST 以外の POST（JS 発行の XHR / `fetch`）**: SW はナビゲーション（`request.mode === "navigate"`）を除く全メソッドを横取りし、`/api/proxy` へ振り向ける（[§Service Worker](#service-worker-による実行時リクエスト横取り)）。フォーム POST 送信はブラウザが `navigate` モードで発行するため SW は素通しし、本節（`/browse` POST ハンドラ）が担う。JS が直接発行する非フォーム POST は SW が `/api/proxy` へ振り向けるため、`/browse` POST ハンドラのスコープ外。

---

## CSS URL 書き換え

`Content-Type: text/css` のレスポンスに対して、正規表現で `url(...)` を書き換える。

**対象パターン**

```
url(["']?<URL>["']?)
@import ["']<URL>["']
```

**変換後**

```
url("/api/proxy?url=<encodeURIComponent(absoluteURL)>")
```

`@import` も同様に `/api/proxy?url=...` へ変換する。

---

## JavaScript

**JS ソースコード自体の書き換え（AST パース）は行わない。** 実装コスト・壊れやすさのリスクが高く、スコープ外とする。

代わりに、JS が実行時に発行するリクエストを **Service Worker（SW）で横取り**して `/api/proxy` 経由へ振り向ける（下記）。

### Service Worker による実行時リクエスト横取り

JS 依存サイト（Google 等）では、画像・スクリプト・XHR などがサーバー側の HTML 書き換え後に **JS が実行時に動的ロード**するため、`rewriteHtml` の属性書き換えだけでは捕捉できず、相対/絶対 URL がプロキシ origin やターゲット origin へ直接飛んで 404 / CORS エラーになる。これを補うため、閲覧ページに SW を登録し、ページ内のリクエスト（**ページ遷移ナビゲーションを除く全メソッド**）を横取りして書き換える。

| リクエスト種別                                                                          | 横取り後                                                                                                                                  |
| --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| クロスオリジンの絶対 URL（例 `https://ssl.gstatic.com/...`）                            | `/api/proxy?url=<absolute>`                                                                                                               |
| 同一オリジンのルート絶対パス（例 `/images/x.png`、`/xjs/...`）                          | ターゲット origin に解決し `/api/proxy?url=<resolved>`                                                                                    |
| 自前ルート（`/browse`・`/api/proxy`・`/_next/*`・`/sw.js`・`/favicon.ico`・ホーム `/`） | 横取りせず素通し                                                                                                                          |
| ページ遷移ナビゲーション（`request.mode === "navigate"`）                               | 横取りせず素通し（サーバー側書き換え・[クライアント側ナビゲーション横取り](#クライアント側ナビゲーションの横取り)・フォーム送信に委ねる） |

- **対象メソッド**: ナビゲーションを除き **GET / POST / PUT / PATCH / DELETE** を横取りする（[§CORS プリフライト対応](#cors-プリフライト対応) のため非 GET も同一オリジンの `/api/proxy` へ振り向ける）。非 GET の振り向けではメソッド・ボディ・リクエストヘッダーを保持する。
- **ターゲット origin の特定**: SW は `fetch` イベントの `clientId` から要求元ページ（`/browse?url=<target>`）の URL を取得し、`url` パラメータをターゲットとして用いる。
- **残存制約（パス相対 URL）**: `foo/bar.png` のようなパス相対 URL はブラウザが閲覧ページ URL（`/browse`）を基準に解決するため、元のターゲット上のパス文脈を復元できず best-effort に留まる。ルート絶対・絶対 URL は正しく振り向けられる。
- **配信と適用範囲**: SW は `public/sw.js` で配信し、登録スコープは `${NEXT_PUBLIC_BASE_PATH}/`。リバースプロキシのパスプレフィックスは SW 自身の登録スコープ（`self.registration.scope`）から導出する。詳細は [arch/proxy.md §Service Worker](../../arch/proxy.md#service-worker-publicswjs)。

---

## CORS プリフライト対応

JS アプリが発行するクロスオリジンの `fetch` / XHR（非単純メソッド・カスタムヘッダー・`application/json` POST 等）は、本来ブラウザがターゲット origin へ **CORS プリフライト（`OPTIONS`）** を飛ばし、ターゲットがプロキシ origin を許可しないため失敗する。

### 方針: プリフライトを「消す」

プリフライトは**クロスオリジン**リクエストでのみ発生する。SW がこれらのリクエストを**同一オリジンの `/api/proxy?url=<target>` へ振り向ける**と、ブラウザから見て同一オリジンになり**プリフライト自体が発生しない**。実際のクロスオリジン取得はサーバー側（`/api/proxy`）が行う（サーバー間通信は CORS の対象外）。

| 層             | 対応                                                                                                                                                                                                                     |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Service Worker | 非 GET 含むサブリソースを同一オリジンの `/api/proxy` へ振り向ける（[§Service Worker](#service-worker-による実行時リクエスト横取り)）。メソッド・ボディ・リクエストヘッダーを保持。`request.mode === "navigate"` は対象外 |
| `/api/proxy`   | `GET` / `POST` / `PUT` / `PATCH` / `DELETE` を中継する。さらに防御的に **`OPTIONS` ハンドラ**を持ち、万一の真のクロスオリジン `OPTIONS`（同一オリジン化されなかった経路）にも応答できる                                  |

### `/api/proxy` の OPTIONS 応答（防御的）

要求元 `Origin` が **リクエスト自身の Host と同一オリジン**の場合のみ、その `Origin` をエコーした CORS 許可ヘッダーを **204** で返す（純粋関数 `buildCorsPreflightHeaders` ＋ `allowedCorsOrigin`）。SW は正当なサブリソースを同一オリジンの `/api/proxy` へ振り向けるため、許可すべきは自プロキシ origin のみ。第三者クロスオリジンからの無検証エコー＋`Allow-Credentials` を防ぐ（#27）。

| ヘッダー                           | 値                                                                                                                              |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `Access-Control-Allow-Origin`      | 要求元 `Origin` が自プロキシと**同一オリジンの場合のみ**エコー。不一致・`Origin` 無しなら付与しない（`*` フォールバックは廃止） |
| `Access-Control-Allow-Methods`     | `GET, POST, PUT, PATCH, DELETE, OPTIONS`                                                                                        |
| `Access-Control-Allow-Headers`     | `Access-Control-Request-Headers` をエコー（無ければ `*`）                                                                       |
| `Access-Control-Allow-Credentials` | 同一オリジンと判定し `Allow-Origin` をエコーした場合のみ `true`（`*` と `credentials` は併用不可）                              |
| `Access-Control-Max-Age` / `Vary`  | `600` / `Origin`                                                                                                                |

`GET` / 中継レスポンスにも、要求 `Origin` が**同一オリジンと判定された場合のみ**同様の `Access-Control-Allow-Origin` / `-Credentials` を付与する（`allowedCorsOrigin` で照合。同一オリジン取得には `Origin` が付かないため、通常のアセット中継には影響しない）。

### 非 GET 中継のリクエストヘッダー転送

SW が振り向けた非 GET リクエストは、ターゲットの API が要求する `Content-Type` やカスタムヘッダー（`X-CSRF-Token` 等）を保持する必要がある。そのため `/api/proxy` の非 GET 中継では、**拒否リスト方式**でリクエストヘッダーを広めに転送する（純粋関数 `relayRequestHeaders`）。

- **拒否（転送しない）**: hop-by-hop・インフラ系（`host` / `connection` / `content-length` / `transfer-encoding` / `keep-alive` / `te` / `upgrade` / `accept-encoding`〔`proxyFetch` が `identity` 固定のため〕）に加え、**プロキシ自身の文脈を漏らす `origin` / `referer`**（プロキシ origin・`/browse?url=…` 閲覧 URL のターゲットへの漏えい防止。サーバー間中継のため `Origin` 無し＝同一オリジン扱いとなり多くの API でむしろ整合する。#27）。
- **転送する**: 上記以外（`Content-Type`・`Authorization`・`Cookie`・`X-*` 等）。
- `GET` 中継は従来どおり許可リスト（`forwardableRequestHeaders`＝`Cookie` / `Authorization`）を維持する（既存挙動の回帰を避けるため）。
- **`Cookie` のサイト別スコープ抽出**: 転送する `Cookie` は、`forwardableRequestHeaders` / `relayRequestHeaders` の両方で**現ターゲット origin にスコープされた Cookie だけ**を抽出・復元する（[§サイト間 Cookie アイソレーション](#サイト間-cookie-アイソレーション)）。プロキシ自身のインフラ認証 cookie（`CF_Authorization` 等）はスコープ化されていないため自動的に除外される。抽出後に Cookie が残らなければ `Cookie` ヘッダー自体を付けない。

### セキュリティ上の制約

- **転送ヘッダーのハードニング（#27 対応済み）**: 非 GET 中継は拒否リスト方式で広めに転送するが、`Cookie` は現ターゲット origin にスコープされた分のみへ限定し（[§サイト間 Cookie アイソレーション](#サイト間-cookie-アイソレーション)）、プロキシ自身の文脈を漏らす `origin` / `referer` は除外する。`Authorization` は `Set-Cookie` のようなサーバー側往復機構が無くスコープ鍵を付与できないため、**クライアントが当該リクエストに明示設定した値のみをそのまま転送する**（サイト別アイソレーションは対象外）。
- **CORS 許可オリジンの制限（#27 対応済み）**: `OPTIONS` 応答・中継レスポンスの `Access-Control-Allow-Origin` は、要求 `Origin` がリクエスト自身の Host と同一オリジンの場合のみエコーする（純粋関数 `allowedCorsOrigin`）。第三者クロスオリジンへ無検証エコー＋`Allow-Credentials` を返さない。SW の同一オリジン化により正当なクライアントは常に自プロキシ origin であり、回帰は無い。
- **`credentials` の扱い**: SW は振り向け時に `credentials: "same-origin"` を用いる（振り向け先は常に同一オリジンの `/api/proxy`）。これにより、プロキシ自身が認証プロキシ（Cloudflare Access 等）の背後にある場合でも、プロキシ origin の認証 cookie（`CF_Authorization` 等）が `/api/proxy` へ届き、プロキシ自身の認証を通過できる（`omit` だと未認証とみなされログインページへ 302 され CORS で失敗していた）。届いたプロキシ origin の cookie はスコープ化されていないため、上流転送のスコープ抽出で除外される（[§サイト間 Cookie アイソレーション](#サイト間-cookie-アイソレーション)）。

---

## ターゲットへ送る既定 User-Agent

プロキシがターゲットへ送る既定の `User-Agent` は**現代ブラウザ相当（Chrome 系）の固定文字列**とする。

- **目的**: 一部サイトは `User-Agent` を見てレイアウトを出し分け、未知・非ブラウザの UA に対しては簡易（レガシー）レイアウトや「推奨ブラウザー」警告ページを返す。独自 UA（例: `web-proxy/1.0`）だと崩れた表示になるため、現代ブラウザ相当の UA を送ってフル版を取得する（例: `yahoo.co.jp` は独自 UA で 34KB の簡易版、Chrome UA で 180KB のフル版を返す）。
- **上書き**: 環境変数 `PROXY_USER_AGENT`（サーバー専用。`NEXT_PUBLIC_` 接頭辞なし）が設定されていればそれを既定 UA として用いる。未設定時は固定の現代 Chrome 相当 UA を用いる。
- **呼び出し側の優先**: ヘッダー転送（`forwardableRequestHeaders` / `relayRequestHeaders`）等で `User-Agent` が個別指定された場合は、既定値より呼び出し側の値が優先される（既定ヘッダーへの上書き結合）。この優先は**ヘッダー名の大文字小文字を問わず**成立する。`relayRequestHeaders` は受信ヘッダーを小文字キー（`user-agent`）で返すが、既定の `User-Agent`（大文字）と二重化させず呼び出し側の値で上書きする（HTTP ヘッダー名はケース非依存＝ RFC 7230。#43）。
- **既知の制約**: UA は実ブラウザを騙る固定値のため実際の閲覧環境とは一致しない。サイトごとの最適 UA 出し分けや、ブラウザの実 UA 転送は対象外（必要なら別途検討）。

---

## 認証情報の転送（Cookie / Authorization）

ログイン状態を伴う閲覧を成立させるため、リクエストの認証ヘッダーをターゲットへ**ベストエフォートで転送する**。

### 転送の方向と処理

| 方向                  | 処理                                                                                                                                                                                                                                                                                                                         |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ブラウザ → ターゲット | `Cookie` / `Authorization` を**許可リスト方式**で転送する（`headers.ts` の純粋関数 `forwardableRequestHeaders` で抽出）。`Cookie` は**現ターゲット origin にスコープされたものだけ**を抽出・復元して転送する（[§サイト間 Cookie アイソレーション](#サイト間-cookie-アイソレーション)）。全リクエストヘッダーの素通しはしない |
| ターゲット → ブラウザ | `Set-Cookie` の `Domain` 属性を除去し、**Cookie 名をターゲット origin でスコープ化**して返す。`Secure` / `SameSite` / `Path` はそのまま維持                                                                                                                                                                                  |

- **対象ハンドラ**: `/browse`（`GET` / `POST`）と `/api/proxy`（`GET`）の両方で転送する。認証が要る画像・CSS・JS（アセット）も取得できるようにするため、アセット中継にも付与する。
- **往復の成立**: `Set-Cookie` の `Domain` を除去することで Cookie はプロキシ origin に保存され、以降のリクエストでブラウザがプロキシ origin 宛に送る `Cookie` のうち**当該 origin にスコープされた分**を本転送でターゲットへ戻す。これにより認証セッションが維持される。

### サイト間 Cookie アイソレーション

URL 書き換え方式のため、すべての中継先は**単一のプロキシ origin** から配信される。素朴に Cookie を中継すると、プロキシ origin に集約された Cookie が中継先を問わず送出され、あるサイトの Cookie が別サイトの中継リクエストに乗る（クレデンシャル混在・漏えい）。これを防ぐため、**Cookie 名にターゲット origin のスコープ鍵を付与**して保持し、往路では現ターゲット origin に一致する Cookie だけを復元して転送する（サーバー側 Cookie ストアは持たない＝ステートレス）。

- **スコープ鍵**: `cookieScopeKey(origin)` = `base64url(origin)`。`origin` は `scheme://host[:port]`（`URL.origin`、IDN は punycode 化されるため ASCII）。粒度は origin 単位で、[§リダイレクト追従](#リダイレクト追従) の同一オリジン判定と揃える。
- **スコープ名の形式**: `__pxy.<スコープ鍵>.<元の Cookie 名>`。区切り `.` は base64url が使わない文字なので、復元時に最初の `.` でスコープ鍵と元の名前を一意に分離できる。
- **復路（Set-Cookie）**: `Domain` 除去に加えて Cookie 名を上記形式へ書き換える。スコープ鍵には**リダイレクト追従後の最終 URL の origin**を用いる（書き換え基準 `baseUrl` と揃える。#42）。`Path` / `Secure` / `SameSite` は維持する。
- **往路（Cookie）**: 受信 `Cookie` から「現ターゲット origin のスコープ鍵に一致する `__pxy.<鍵>.` 接頭辞を持つ Cookie」だけを抽出し、接頭辞を外して元の名前で転送する。別 origin にスコープされた Cookie・スコープされていない Cookie（プロキシ自身のインフラ認証 cookie 等）は転送しない。これにより上流へ送る Cookie が現ターゲット分に限定され、サイト間の Cookie 混在が起きない。
- **インフラ認証 cookie**: プロキシ自身が認証プロキシ（Cloudflare Access 等）の背後にある場合に付与される cookie（`CF_Authorization` 等）はスコープ化されていないため、往路のスコープ抽出で**自動的に除外**される（専用の除去処理は不要）。
- **既知の制約**: 元 Cookie の `Path` を維持するため、`Path=/` 以外のパス限定 Cookie はプロキシパス（`/browse` / `/api/proxy`）に送り返されない（既存の限界。本機能の対象外）。また本機能の導入前に保存された非スコープ Cookie は転送対象外となるため、再ログインが必要になる。

### セキュリティ上の制約

- **リダイレクト追従時の漏えい（#26 で対応済み）**: かつて `proxyFetch` は `redirect: "follow"` 固定で、クロスオリジンへのリダイレクト時に `Authorization` / `Cookie` を追従先へそのまま送っていた。現在は `redirect: "manual"` 化して自前で追従し、**追従先が元リクエストと別オリジンなら `Authorization` / `Cookie` を除去**する（[§リダイレクト追従](#リダイレクト追従) 参照）。
- **`credentials` 付きクロスオリジン XHR（#28 対応済み）**: SW は非 GET 含むサブリソースを同一オリジンの `/api/proxy` へ振り向け（[§CORS プリフライト対応](#cors-プリフライト対応)）、振り向け `fetch` は `credentials: "same-origin"` を用いる。振り向け先が同一オリジンのため**プロキシ origin に保存されたターゲットのスコープ Cookie が `/api/proxy` まで届き**、往路のスコープ抽出（`scopedCookieHeader`）で**現ターゲット origin 分だけが上流へ転送される**。これにより `fetch(target, { credentials: "include" })` 相当の Cookie ベース・クロスオリジン XHR が、プロキシ経由で保存・スコープ化された Cookie について成立する（[§サイト間 Cookie アイソレーション](#サイト間-cookie-アイソレーション)）。プロキシ自身のインフラ認証 cookie（`CF_Authorization` 等）は非スコープのため上流へは転送されない。
- **`credentials` 付き XHR の既知の制約**: SW は元リクエストの `credentials` モード（`omit` / `same-origin` / `include`）を区別せず一律 `same-origin` で振り向けるため、`credentials: "omit"` の XHR でも**当該ターゲット自身のスコープ Cookie が送られ得る**。ただし送信先は常に現ターゲット origin 分のみで、サイト間の Cookie 混在・漏えいは起きない（[§サイト間 Cookie アイソレーション](#サイト間-cookie-アイソレーション)）。また対象はプロキシ経由で保存・スコープ化された Cookie に限り、プロキシ外で取得した Cookie は対象外。

---

## リダイレクト追従

`proxyFetch` はターゲットのリダイレクト（`301` / `302` / `303` / `307` / `308`）を `redirect: "manual"` で**自前追従**する。ブラウザの `fetch`（`redirect: "follow"`）任せにせず、各ホップを検証することでクロスオリジン漏えい・SSRF を防ぐ。

- **認証情報の保護**: 追従先 URL が**元リクエストと別オリジン**の場合、転送ヘッダーから `Authorization` / `Cookie` を**除去**してから次のリクエストを送る（同一オリジンへのリダイレクトでは維持）。これにより、ターゲットが任意の別オリジンへ誘導しても認証情報が漏れない。
- **SSRF 再チェック**: 追従先 URL も初回と同じ SSRF チェック（[§SSRF 対策](#ssrf-対策)）を**毎ホップ適用**する。リダイレクトで内部 IP・メタデータエンドポイント等へ誘導されても、解決後 IP がブロック対象なら `403` を返す。
- **追従回数の上限**: 最大 5 回まで追従し、超過した場合はループとみなして `502` を返す（リダイレクトループ防止）。
- **タイムアウト**: 全ホップ合計で 1 回分のタイムアウト枠（10 秒）を共有する（ホップごとにリセットしない）。
- **メソッド / ボディ**: `301` / `302` / `303` は追従時に `GET`・ボディなしへ切り替える（一般的なブラウザ挙動）。`307` / `308` はメソッドを保持するが、ボディが `ReadableStream`（再送不可）の場合は安全側に倒して `GET`・ボディなしで追従する。
- **書き換え基準（baseUrl, #42）**: HTML / CSS の URL 書き換え（`rewriteHtml` / `rewriteCss`）の `baseUrl` には、リダイレクト**追従後の最終 URL**を用いる。これにより、`https://yahoo.co.jp/` → `https://www.yahoo.co.jp/` のようなリダイレクト後でも、相対リンク・アセットが最終オリジン基準で正しく解決される。最終 URL も上記 SSRF チェックを通過したものに限られる。

---

## ブラウザバック中継（browser-backed fetch）

> 関連アーキテクチャ: [arch/proxy.md §browserFetch](../../arch/proxy.md#srclibproxybrowserfetchts)。対応 Issue: [#69](https://github.com/f8924919/web-proxy/issues/69)。

URL 書き換え方式（`proxyFetch` + `rewriteHtml` + `public/sw.js`）は、JS が初期 DOM を構築する SPA や JS 実行を前提とするページで構造的に表示が崩れる/取りこぼす。これを補うため、**特定サイトの `/browse` GET だけ**、初回ナビゲーションをサーバー側のヘッドレスブラウザ（インプロセス Playwright）で実行し、**JS 解決後の DOM** を既存 `rewriteHtml` パイプラインへ流す中継経路を設ける。これを **ブラウザバック中継（browser-backed fetch）** と呼ぶ。

> **既存の方式A / 方式B との区別**: [setup.md §8](../../setup.md) の「方式A / 方式B」は**デバッグ用にブラウザが proxy を外から開く**手段であり、本機能（サーバーがブラウザでターゲットを内から取得する中継経路）とは直交した別物。用語衝突を避けるため本機能は「方式C」とは呼ばない。

### ティア（中継方式）の選択

`/browse` GET は、ターゲットごとに 2 つの中継ティアを使い分ける。判定は純粋関数 `shouldUseBrowser(url, config)` が行う。

| ティア             | 実体                             | 用途                                           |
| ------------------ | -------------------------------- | ---------------------------------------------- |
| 中継ティア（既定） | `proxyFetch`（サーバー `fetch`） | 全サイトの既定。高速・低コスト                 |
| ブラウザティア     | `browserFetch`（Playwright）     | allowlist 指定サイトのみ。JS 解決後 DOM を返す |

- **昇格トリガ**: 明示 allowlist / env（既定）に加え、崩れ/チャレンジのヒューリスティック自動検出（[§ヒューリスティック自動ティア昇格](#ヒューリスティック自動ティア昇格崩れチャレンジ検出)、[#70](https://github.com/f8924919/web-proxy/issues/70)）。allowlist が優先で、自動検出は補助。
- **env 設定**:
  - `PROXY_BROWSER_MODE`: `off`（常に中継ティア）/ `allowlist`（host 一致時のみブラウザ）/ `on`（常にブラウザ）。サーバー専用（`NEXT_PUBLIC_` なし）。**未設定・不正値のときは、`PROXY_BROWSER_HOSTS` が非空なら `allowlist`、空なら `off`** にフォールバックする。
  - `PROXY_BROWSER_HOSTS`: カンマ区切りのホスト接尾辞リスト。`example.com` は `example.com` と `*.example.com` に一致する。
  - いずれも未設定なら**常に中継ティア**（既定挙動の回帰なし）。
- **対象は `/browse` GET のみ**。POST・`/api/proxy`（アセット中継）は対象外で常に中継ティア。

### `browserFetch` の振る舞い

- `proxyFetch` と同じ `{ response, finalUrl }` 契約を満たす。`page.content()` の settled DOM を本文（`text/html`）に、`page.url()` を `finalUrl` に用いる。以降は中継ティアと同じ `rewriteHtml` / `sanitizeHeaders` が適用される。
- **待機戦略**: `page.goto` の `waitUntil` / `timeout` と、追加の idle 待ち（settle）を env で調整可能（`debug-browser.mjs` と同じ検証・ベストエフォート方針、[#39](https://github.com/f8924919/web-proxy/issues/39)）。タイムアウト・読み込み失敗でも収集済み DOM をベストエフォートで返す。
- **既定 User-Agent / 認証情報**: 中継ティアと同じ既定 UA（`PROXY_USER_AGENT` で上書き可）をブラウザコンテキストに適用し、受信リクエストの `Cookie` / `Authorization`（現ターゲット origin にスコープされた分）を初回ナビゲーションへ引き継ぐ。

### Cookie セッションウォーミング

ブラウザがナビゲーション中に取得した Cookie（チャレンジ通過後のセッション等）を、**スコープ化して返す**ことで以降の中継へ引き継ぐ。

- ブラウザの cookie jar（`context.cookies()`）を `Set-Cookie` 相当へ変換する（`Domain` は付けない）。
- 変換した `Set-Cookie` は既存の[サイト間 Cookie アイソレーション](#サイト間-cookie-アイソレーション)（`sanitizeSetCookie`）でスコープ化されてブラウザへ返る。
- 以降、ブラウザが送り返す `Cookie` のうち現ターゲット origin 分を `scopedCookieHeader` が抽出して上流（`/api/proxy` 等）へ転送する。これにより**ブラウザで温めたセッションを軽量な中継ティアへ引き継ぐ**。

### SSRF（不弱化）

ブラウザは任意の JS を実行し任意のサブリクエストを発行するため、中継ティアと**同等の SSRF 保証**を維持する。

- 初回ナビゲーション URL に[SSRF チェック](#ssrf-対策)を適用する（ブロック時 403）。
- ブラウザの**全サブリクエスト**にも解決後 IP のブロックリスト照合を適用し、ブロック対象は中断する（`context.route` 傍受）。

### 失敗時のフォールバック

ブラウザの起動失敗・タイムアウト・例外時は、SSRF ブロックを除き**中継ティア（`proxyFetch`）へフォールバック**する（ブラウザ依存で全損にしない）。SSRF ブロックは 403 を返す。

### ヒューリスティック自動ティア昇格（崩れ/チャレンジ検出）

> 関連アーキテクチャ: [arch/proxy.md §promotion.ts](../../arch/proxy.md#srclibproxypromotionts)。対応 Issue: [#70](https://github.com/f8924919/web-proxy/issues/70)。

明示 allowlist は手動運用のため、未知サイトの崩れには追従できない。これを補うため、**中継ティア（`proxyFetch`）の初回応答が「崩れている / チャレンジが挟まっている」と判定された場合、自動でブラウザティアへ昇格して再取得**する。allowlist 昇格を**補助**する位置づけで、allowlist が優先（既にブラウザティアの場合は二重取得しない）。

- **有効化**: 専用 env `PROXY_BROWSER_AUTO_PROMOTE`（`true` / `1` / `on` で有効、**既定は無効**）。無効時は明示 allowlist のみが従来どおり動く。本機能はブラウザティア（Playwright）が利用可能な環境での運用を前提とする。
- **対象**: `/browse` **GET の `text/html` 応答のみ**。POST はボディ再送不可のため対象外、`/api/proxy`（アセット中継）・非 HTML 応答・allowlist で既に昇格済みのリクエストも対象外。
- **昇格判定（純粋関数 `shouldPromoteToBrowser(html, status, contentType)`）**: 初回（中継ティア）応答の HTML / ステータス / Content-Type を入力に取り、`text/html` 応答について次の**いずれか**で昇格と判定する。
  - **チャレンジ / bot 判定マーカー**: `enable javascript` / `enablejs` / `checking your browser` / `recaptcha` / Cloudflare チャレンジ等の語句を本文に含む。
  - **`<noscript>` 主体**: `<noscript>` を含み、かつ noscript 外の可視テキストが極小（JS 無効向け案内が本文の主要部）。
  - **bot ブロック相当ステータス**: `403` / `503`。
  - 空 body 単独は誤検知が多いため判定材料にしない（上記マーカー / noscript / ステータスのみを使う）。
- **二重取得コストの抑止（無限ループ防止）**: 同一 URL を短時間ウィンドウ内で一度昇格したら**再昇格しない**。これにより `proxyFetch` → 崩れ検出 → `browserFetch` の二重取得を、URL あたり高々 1 回 / ウィンドウに制限する。
  - **抑止キー**: `ホスト + パス`（**クエリ無視**。[§ナビゲーションループの検出](#ナビゲーションループの検出enablejs-対策)と同方式。`sei` 等の毎回変化するクエリで抑止が外れないようにする）。
  - インメモリ・スライディングウィンドウ（[レート制限](#レート制限)と同方式、プロセス再起動でリセット）。
- **誤検知時の影響最小化（best-effort）**: 昇格後の `browserFetch` が失敗・例外の場合は、初回の中継ティア応答を**そのまま返す**（昇格は best-effort で全損にしない）。SSRF は初回ナビゲーション URL で既に検査済み。

| 項目           | 既定値                                                                           |
| -------------- | -------------------------------------------------------------------------------- |
| 有効化 env     | `PROXY_BROWSER_AUTO_PROMOTE`（既定 無効）                                        |
| 対象           | `/browse` GET の `text/html` 応答のみ（POST・非 HTML・allowlist 既昇格は対象外） |
| 昇格判定       | チャレンジ語句 / `<noscript>` 主体 / `403`・`503` のいずれか                     |
| 再昇格抑止キー | ホスト + パス（クエリ無視）                                                      |
| 抑止ウィンドウ | 60 秒                                                                            |
| 昇格失敗時     | 初回の中継ティア応答へフォールバック（best-effort）                              |

> **限界**: 本機能はブラウザティアで解決できる「崩れ / JS チャレンジ」を自動で拾うものであり、egress IP に由来する no-JS 判定や本格的なアンチボット突破を保証するものではない（[#73](https://github.com/f8924919/web-proxy/issues/73)）。検出は best-effort で、誤検知時も初回応答へフォールバックして体験を悪化させない設計とする。

### ブラウザ実行基盤（バックエンドの差し替え・#71）

本番のブラウザ実行場所は、`browserFetch` の**インターフェース契約を変えずに**バックエンドだけを env で差し替えられる構成とする（[#71](https://github.com/f8924919/web-proxy/issues/71)。比較・採用方針・デプロイ手順は [setup.md §9](../../setup.md#9-本番デプロイブラウザ実行基盤71)）。

| バックエンド          | 選択方法                                 | 用途                                                                                                                                                    |
| --------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 自前 Chromium（既定） | `PROXY_BROWSER_CDP_URL` 未設定           | コンテナに Chromium を同梱しインプロセス `chromium.launch()`。自己完結・無課金                                                                          |
| 外部ブラウザサービス  | `PROXY_BROWSER_CDP_URL` を CDP/WS に設定 | `chromium.connectOverCDP()` で外部へ接続。資源・stealth・**クリーン egress IP**（[#73](https://github.com/f8924919/web-proxy/issues/73)）を外部へ逃がす |

- **採用方針**: 既定は自前 Chromium 同梱（コンテナ）。**egress IP（#73）やアンチボットが要件のときのみ**、クリーン IP を持つ外部 CDP サービスへ env で切り替える。Playwright は本番でブラウザ中継を使うため devDependency から **dependency へ昇格**する。
- **egress IP（#73）の扱い**: 自前 Chromium 同梱は egress IP がサーバー IP のまま。クリーン IP を通すには (1) 外部 CDP サービス（residential/クリーン IP を持つもの）へ切り替える、または (2) 自前ブラウザを上流プロキシ経由にする（[§アンチボット対策](#アンチボット対策egress-ip--stealth73)）。
- ブラウザ実行は中継より大幅に遅く高コストなため、**同時実行数の上限**を設ける。レート制限（[§レート制限](#レート制限)）とは別軸。
- **表示後の動的操作**（無限スクロールの追加読込・動的 XHR・クリック遷移）は依然として既存の横取り任せ（本機能は初回レンダリングのスナップショット）。根本解決は RBI（[#72](https://github.com/f8924919/web-proxy/issues/72)）。

### アンチボット対策（egress IP / stealth・#73）

> 対応 Issue: [#73](https://github.com/f8924919/web-proxy/issues/73)。比較・運用・法的留意は [setup.md §9.4](../../setup.md#94-アンチボット対策egress-ip--stealth73)。

ヘッドレス化＝アンチボット突破ではない。実用上の阻害要因は 2 つで、**egress IP レピュテーションが支配的**（[#52] の調査結論。データセンター IP は Google 等の no-JS / bot 判定で弾かれる）、次いでヘッドレス検出（`navigator.webdriver` 等）。本機能は最小対策を提供するが、**突破を保証しない**。

- **egress IP（最小実装）**: 自前ブラウザの上流プロキシを env `PROXY_BROWSER_PROXY_SERVER`（任意で `..._PROXY_USERNAME` / `..._PROXY_PASSWORD`）で指定でき、residential / クリーン IP プロキシを通せる。外部 CDP サービス（[§ブラウザ実行基盤](#ブラウザ実行基盤バックエンドの差し替え71)）に IP プールごと委ねる選択肢と両立する。未設定なら従来どおりサーバー IP で直アクセス（既定挙動不変）。
- **stealth（最小実装・組み込み軽量）**: 自前 `chromium.launch()` に `--disable-blink-features=AutomationControlled` を付与し、全 context へ `navigator.webdriver` を隠す init script を注入する。依存追加なしの軽量対策で、`navigator.webdriver` / `AutomationControlled` 由来の単純なヘッドレス判定を緩和する。**網羅的な stealth（playwright-extra/stealth 相当）は導入しない**（egress IP が支配的で費用対効果が低いため）。外部 CDP サービス利用時は当該サービスの stealth 機能に委ねる。
- **限界・法的留意**: 本対策でも Google 検索等の本格的アンチボットの突破は保証しない。最終的な可否は egress IP の質に依存する。対象サイトの利用規約・residential プロキシの規約/法令順守はデプロイ運用者の責任とする（[setup.md §9.4](../../setup.md#94-アンチボット対策egress-ip--stealth73)）。
- **実測（未実施・キー入手後）**: Google 検索（enablejs ループ・[#52]）を代表ケースに、ブラウザティア＋クリーン IP / stealth でどこまで通るかの実測は、外部サービスの有料アカウント/キー入手後に行う（手順は [setup.md §9.4](../../setup.md#94-アンチボット対策egress-ip--stealth73)）。

[#52]: https://github.com/f8924919/web-proxy/issues/52

---

## レスポンスヘッダー処理

以下のヘッダーを除去してからブラウザへ返す。

| 除去対象                  | 理由                                                                                                                          |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `Content-Security-Policy` | プロキシの書き換え済みリソースをブロックする                                                                                  |
| `X-Frame-Options`         | iframe 埋め込み対応の障害になる                                                                                               |
| `Content-Encoding`        | fetch 後に展開済みのため再設定不要                                                                                            |
| `Transfer-Encoding`       | 同上                                                                                                                          |
| `Speculation-Rules`       | ブラウザがページ内の `/browse?url=...` リンクを prefetch し、各先読みがフル中継としてレート枠を消費するのを防ぐ（防御的措置） |

`Content-Type` / `Cache-Control` などはそのまま維持する。

> **前段 CDN（Cloudflare 等）の Speculation/Prefetch について**: `sanitizeHeaders` が除去できるのは**上流（ターゲット）応答**のヘッダーのみ。プロキシ自身の前段に Cloudflare 等がいる場合、`Speculation-Rules`（`/cdn-cgi/speculation` を指す）はアプリ応答の**後段**で注入されるためコードからは除去できない。同一オリジン（プロキシのドメイン）の `/browse?url=...` リンクが prefetch されると中継リクエストが増え、レート制限の枯渇やターゲットへの過剰アクセスを招くため、**当該ドメインでは CDN 側の Speculation Rules / Prefetch URLs 機能を無効化する**こと。

---

## ステータスコードの中継

ターゲットのレスポンスステータスは原則そのままブラウザへ中継する。ただし次の制約を守る。

- **ボディを持てない `204` / `205` / `304`** は、ボディ付きで `Response` を構築すると例外になるため、**ボディを `null` として中継する**（ステータスは維持）。
- **`1xx`（`101` など）** は最終応答として中継できない（`Response` のステータスは `200`〜`599` に限られ、`101` はボディ `null` でも構築が例外になる）。`fetch` が 1xx を最終応答として返すことは実運用ではほぼ無いが、来た場合は下記フォールバックにより **`502`** となる。
- 上記以外でも、**ステータスが `200`〜`599` の範囲外**、または中継・変換（CSS / HTML 書き換え等）の途中で**予期しない例外**が発生した場合は、ハンドラをクラッシュ（500）させず **`502`** を返す。

---

## SSRF 対策

DNS 解決は **IPv4 固定**（`dns.lookup` の `family: 4`）。IPv6 専用ホストへのアクセスは非対応（v2 以降）。

フェッチ前にホスト名を DNS 解決し、解決後の IPv4 アドレスを以下のブロックリストと照合する。

| ブロック対象             | 例                                              |
| ------------------------ | ----------------------------------------------- |
| ループバック             | `127.0.0.0/8`                                   |
| プライベートネットワーク | `10.0.0.0/8`、`172.16.0.0/12`、`192.168.0.0/16` |
| リンクローカル           | `169.254.0.0/16`                                |
| クラウドメタデータ       | `169.254.169.254`                               |
| 未指定アドレス           | `0.0.0.0`                                       |

ブロック対象の場合は HTTP 403 を返す。**リダイレクト追従時は追従先 URL にも毎ホップ同じチェックを適用する**（[§リダイレクト追従](#リダイレクト追従)）。

> IPv6 SSRF ブロック（`::1`・`fe80::/10` 等）・DNS リバインディング対策は v2 以降の課題。

---

## レート制限

**インメモリ・スライディングウィンドウ方式（IP ベース）。**

ページ遷移（`/browse`）とアセット中継（`/api/proxy`）は**別々のバケット・別々の上限**で制限する。1 枚の JS 重サイト（Google 検索等）は Service Worker により画像・スクリプト・XHR を多数 `/api/proxy` へ振り向けるため、両者を同一枠（旧: 60 req/分 共有）にすると 1 ページの読み込みだけで枠が枯渇し、後続のページ遷移が 429 になっていた。これを避けるためアセット側の上限を大きく取る。

| エンドポイント           | 上限                     | 用途                                       |
| ------------------------ | ------------------------ | ------------------------------------------ |
| `/browse`（ページ遷移）  | 60 リクエスト / IP / 分  | 人間のページ遷移を想定した上限             |
| `/api/proxy`（アセット） | 600 リクエスト / IP / 分 | 1 ページが中継する多数のサブリソースを許容 |

| 項目               | 値                                          |
| ------------------ | ------------------------------------------- |
| 超過時のレスポンス | HTTP 429                                    |
| 実装               | `Map<ip, timestamps[]>`（ライブラリ不使用） |

### クライアント IP の特定

レート制限のバケットキーに使うクライアント IP は、リバースプロキシ / CDN 配下でも実クライアントを識別できるよう次の優先順で解決する。いずれも得られない場合のみ `"unknown"`（単一バケット）にフォールバックする。

```
cf-connecting-ip  →  x-forwarded-for（先頭の値）  →  x-real-ip  →  "unknown"
```

> `"unknown"` に潰れると全アクセスが単一バケットを共有するため、デプロイ環境では上記いずれかのヘッダが実クライアント IP で届くこと（リバースプロキシ側の転送設定）が前提。

永続化・分散対応は v2 以降。

---

## ナビゲーションループの検出（enablejs 対策）

一部のサイト（Google 検索の「enable JavaScript」インタースティシャル等）は、JS が現在ページを `?…&sei=<毎回変化>` のように毎回異なるクエリを付けて自分自身へ再ナビゲーションし続ける。各遷移は Service Worker を素通しして `/browse` を叩くため、放置すると無限リロードとなり、最終的に [レート制限](#レート制限)（`/browse` 60 req/分）に当たって 429 で停止する（ユーザーには延々リロードした末に 429／空白が表示される悪体験）。

これを検出して打ち切るため、`/browse`（GET / POST）は以下を行う。

- **検出キー**: `IP ×（ホスト + パス）`。**クエリ文字列は無視する**（`sei` のように毎回変わるパラメータでループするため、クエリを含めると同一ナビゲーションと見なせない）。
- **判定**: 同一キーへの遷移が短時間ウィンドウ（既定 10 秒）内に閾値（既定 6 回）を超えたらループとみなす。
- **応答**: ループ検出時はターゲットの中継 HTML（ループを駆動する JS を含む）を返さず、**自動遷移を一切含まない静的な案内ページ**（HTTP 200）を返す。これにより当該タブで動いていた再ナビゲーション JS が案内ページに置き換わり、ループが停止する。案内には状況説明と「ホームへ戻る」リンクのみを含める（meta refresh / 自動 location 遷移を含まない）。
- **発火順**: レート制限（60 req/分）に達する前に発火する（閾値 6 回 / 10 秒 ≪ 60 回 / 分）。

| 項目               | 既定値                                         |
| ------------------ | ---------------------------------------------- |
| 検出キー           | IP + ホスト + パス（クエリ無視）               |
| ウィンドウ         | 10 秒                                          |
| 閾値               | 6 回                                           |
| 検出時のレスポンス | HTTP 200 + 静的案内 HTML（自動遷移を含まない） |

> **誤検知について**: 閾値・ウィンドウは、人間が同一ページを短時間に数回開く通常操作では発火せず、別 URL の連続遷移にも影響しない値に設定する。実装は [レート制限](#レート制限) と同じインメモリ・スライディングウィンドウ方式で、プロセス再起動でリセットされる。
>
> **限界**: 本検出はループの UX（無限リロード・429 連打）を止めるものであり、Google 検索自体を proxy で使えるようにするものではない（no-JS 判定は egress IP に由来し支配的）。チャレンジ突破の可否は別途調査する。

---

## 関連

- [ホーム画面仕様](../screens/home.md)
- [ブラウズ画面仕様](../screens/browse.md)
