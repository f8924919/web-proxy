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
  │ GET /browse/<scheme>/<host>/<path>  （1. ページ要求。パス反映・#115。
  │   （旧 /browse?url= は 307 でこの形式へ）   外部リンク等の ?url= は受理し 307 リダイレクト）
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

| メソッド | パス                                | 役割                                                                                                                                                                                                                     |
| -------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET`    | `/browse/<scheme>/<host>/<path>`    | アドレスバー付きの閲覧ページ（パス反映・正本。#115）。URL スキームは [§ページ遷移のパス反映](#ページ遷移のパス反映115) を参照。後方互換として旧 `/browse?url=<encoded>` も受理し**パス反映 URL へ 307 リダイレクト**する |
| `POST`   | `/browse/<scheme>/<host>/<path>`    | フォーム POST 送信の中継（リクエストボディと `Content-Type` をターゲットへ転送。詳細は [§POST 中継](#post-中継)）。後方互換で `/browse?url=<encoded>` も受理（POST はリダイレクトせず直接中継）                          |
| `GET`    | `/api/proxy/<scheme>/<host>/<path>` | 静的アセットの透過中継（CSS・画像・JS をそのまま返す）。URL スキームは [§プロキシ URL スキーム（パス反映）](#プロキシ-url-スキームパス反映) を参照。後方互換として旧 `/api/proxy?url=<encoded>` も受理する               |

### `url` 未指定時の案内ページ（GET）

`GET /browse` に `url` が無い場合（GET フォーム横取りの取りこぼし・`location`/`history` 駆動の JS ナビゲーションでの `url` 喪失・`/browse` への直接遷移など）は、**アドレスバー付きの案内ページ（HTTP 200）をその場で返す**（自動遷移を含まない）。ユーザーはアドレスバーに URL を入力して続行できる。

- **リダイレクトしない理由（#74）**: 以前はホーム（`${BASE_PATH}/`）へ 307 リダイレクトしていたが、リバースプロキシ（code-server のポート転送 `/proxy/3000`）配下では戻り先が **404** になっていた（Next は basePath 未使用でアプリのホーム実体は `/`。`/proxy/3000/` が末尾スラッシュ正規化で `/proxy/3000` に落ち 404）。リダイレクトを廃し、`/browse`（リバースプロキシが正しくプレフィックスを剥がす経路）で 200 ページを直接返すことでこの 404 を解消する。内部オリジン漏えい防止（旧 #55 の相対 `Location` 要件）は、そもそもリダイレクトを行わないため不要になる。
- **案内ページの導線**: 既存のアドレスバー（`#proxy-addressbar`）を再利用する。フォーム submit は `${BASE_PATH}/browse?url=<入力>` へ遷移する（正しく解決される経路）。meta refresh / location 自動遷移は含めない。
- **引き金（スコープ外）**: `url` 喪失の主因の一つは、Google 等の `location.assign` / `history` API による JS 駆動ナビゲーション（[§クライアント側ナビゲーションの横取り](#クライアント側ナビゲーションの横取り)の対象外）。本節はその場合に 404 ではなく案内ページを見せる対症であり、横取りの拡張は別課題。
- `POST /browse` の `url` 欠落・不正は、案内ページではなく **400** を返す（[§POST 中継](#post-中継)）。

---

## プロキシ URL スキーム（パス反映）

アセット中継 URL（`/api/proxy`）は、**ターゲットの scheme / host / path をクエリではなく URL パスにそのまま反映する**形式を正本とする。

**形式**

```
${BASE_PATH}/api/proxy/<scheme>/<host>/<targetPath><?targetQuery><#hash>
例) https://premium.yahoo.co.jp/_main/nuxt/x.js
  → ${BASE_PATH}/api/proxy/https/premium.yahoo.co.jp/_main/nuxt/x.js
```

- `<scheme>` は `http` / `https`。`<host>` はポート込み（例 `host:8080`）だが、中継先のポートは[§中継対象スキーム・ポートの制限](#中継対象スキームポートの制限133)に従い既定で 80 / 443 のみ許可する（許可外は `403`）。`<targetPath>` はターゲットのパスを percent-encoding 済みのまま反映する。ターゲットのクエリ（例 `/_next/image?url=…`）は中継 URL のクエリへそのまま載せる。
- **特殊パスの percent-encoding 保持**: パス／クエリ中の `%2F`（エンコード済みスラッシュ）や非 ASCII（日本語等の `%E3%81%…`）は、デコード／再エンコードを挟まず**そのままの percent-encoding で**ターゲットへ転送する。`%2F` を生の `/` に潰すとパス構造が変わり別リソースを指してしまうため。実装は `buildProxyPath` が WHATWG `URL` の `pathname`（`%2F` を正規化しない）を用い、復元側 `targetFromProxyPath` はデコード済み catch-all params ではなく**生の `req.nextUrl.pathname` を文字列処理**で扱うことでこれを保証する（[arch/proxy.md](../../arch/proxy.md) の Route Handler 節・回帰テスト `tests/lib/proxy/proxyPath.test.ts`）。

**なぜパス反映か（#100）**: 旧 `/api/proxy?url=<encoded>` クエリ方式では、配信される JS モジュールの `import.meta.url` のディレクトリが常に `…/api/`（クエリより前）に固定され、**チャンク分割 SPA（Nuxt/Vite/webpack 等）がランタイムで発行する相対 import（`import('./chunk.js')`）が `…/api/chunk.js` に解決**されてしまう。これを SW がターゲット origin 直下（`<host>/api/chunk.js`）へ誤振り向けし 404・MIME エラーになる（動的 import 失敗）。パス反映方式ではモジュールの URL ディレクトリがターゲットのディレクトリを反映するため、相対 import はブラウザ上でネイティブに正しく解決され、SW を介さずに（`/api/proxy/…` は自前ルート＝素通し）正しい中継 URL に着地する。

- **後方互換**: ルートは旧 `/api/proxy?url=<encoded>` も引き続き受理する（デプロイ跨ぎで残る既存ページ／旧 SW のリクエスト救済）。新規に生成する書き換え URL・SW 振り向けは常にパス反映形式を用いる。
- **適用範囲**: 本スキームはアセット中継（`/api/proxy`）と**ページ遷移（`/browse`）の両方**に適用する（ページ遷移は #115 で path 反映へ移行。当初 #100 ではアセットのみを対象とし「ページ遷移は対象外」としていたが、後述の理由で navigation にも拡張した）。

### ページ遷移のパス反映（#115）

ページ遷移（ブラウズ）も**ターゲットを URL パスへ反映**する形式を正本とする。

```
${BASE_PATH}/browse/<scheme>/<host>/<targetPath><?targetQuery>
例) https://duckduckgo.com/?ia=web&q=test
  → ${BASE_PATH}/browse/https/duckduckgo.com/?ia=web&q=test
```

**なぜパス反映か（#115）**: 旧 `/browse?url=<encoded>` クエリ方式では、閲覧ページの `location`（`location.search` / `location.pathname`）に **proxy 専用パラメータ `url=<target>` が露出**する。ターゲットの SPA（React 等）が `location.search` を読んでリンクを再構築すると、`url=` を自分のクエリとして取り込み、`/?url=<target>&ia=images` のような壊れたリンクを生成する（例 DuckDuckGo のナビタブ All/Images）。また**ターゲット本来のクエリ（`q=test`）が `url=` のエンコード値の中に埋もれ**、SPA からトップレベル param として見えない。パス反映方式では `location` がターゲットそのものを反映する（`location.search` = `?ia=web&q=test`）ため、SPA は正しいリンク（`/?ia=images&q=test`）を生成し、クエリのみの相対リンク（`?q=…`）はブラウザのネイティブ解決で正しく着地する。これはアセットで `import.meta.url` をターゲットのディレクトリに一致させた #100 と同じ発想を navigation に適用したもの。

- **後方互換 / リダイレクト**: GET `${BASE_PATH}/browse?url=<encoded>`（旧形式・外部リンク・ブックマーク・アドレスバー入力）は受理し、**パス反映 URL へ 307 リダイレクト**する。これにより `?url=` 経由で入っても最終的に閲覧ページの `location` がクリーンになる。POST `/browse?url=` は当面クエリ方式のまま直接中継する（POST 着地ページの `location` を SPA が読むケースは稀なため）。
- **`%2F` / 非 ASCII**: アセット中継と同じく percent-encoding を保持する（#111）。

---

## HTML 書き換え

### 使用ライブラリ

**`node-html-parser`** を採用する。

- 依存ゼロで軽量・高速
- 属性ベースの書き換えが素直に書ける（cheerio より軽量）

### 書き換えルール

相対パスはターゲットサイトのオリジンを基準に絶対 URL へ変換し、いずれも上記 §プロキシ URL スキームのパス反映形式へ書き換える。ナビゲーション系（`<a>` / `<form>`）は `/browse/<scheme>/<host>/<path>`（#115）、アセット系（`<img>` / `<link>` / `<script>` / `srcset`）は `/api/proxy/<scheme>/<host>/<path>`（#100）。

| 対象タグ / 属性                    | 遷移先ルート                                    | 理由                                                       |
| ---------------------------------- | ----------------------------------------------- | ---------------------------------------------------------- |
| `<a href>`                         | `/browse/<scheme>/<host>/<path>`（パス反映）    | リンク先もブラウズ画面で開く（#115）                       |
| `<form action>`                    | `/browse/<scheme>/<host>/<path>`（パス反映）    | フォーム送信もプロキシ経由（GET は下記スクリプトで補完）   |
| `<iframe src>`                     | `/browse/<scheme>/<host>/<path>`（パス反映）    | 埋め込みページもブラウズ画面で開く（枠外離脱防止・#135）   |
| `<img src>`                        | `/api/proxy/<scheme>/<host>/<path>`（パス反映） | 透過中継（UI 不要）                                        |
| `<video src>` / `<audio src>`      | `/api/proxy/<scheme>/<host>/<path>`（パス反映） | メディアの透過中継（#135）                                 |
| `<source src>`                     | `/api/proxy/<scheme>/<host>/<path>`（パス反映） | `<picture>`／`<video>`／`<audio>` 内ソースの透過中継       |
| `<img srcset>` / `<source srcset>` | 各候補 URL をパス反映形式                       | 透過中継（記述子 `1x` / `2x` / `640w` 等は保持。下記参照） |
| `<link href>`                      | `/api/proxy/<scheme>/<host>/<path>`（パス反映） | 透過中継                                                   |
| `<script src>`                     | `/api/proxy/<scheme>/<host>/<path>`（パス反映） | 透過中継                                                   |

> パス反映形式の組み立て・`%2F`／非 ASCII の percent-encoding 保持は上記 §プロキシ URL スキーム（パス反映）を参照。

### `<base href>` の処理（枠外離脱防止・#135）

中継先 HTML 内の `<base href>` は相対 URL 解決の基点を変える。残したままにすると、書き換えで取りこぼした属性や実行時に生成される相対 URL がブラウザによって `<base href>` 基準で解決され、`<base href="https://evil/">` のような指定でプロキシ枠を外れた実サイトへ直アクセスし得る（OWASP A03:2021 周辺 / CWE-79 周辺）。注入シム（実行時 fetch/XHR 横取り・SW）は `location.href`（現ページ URL）を基準点とするため `<base href>` を参照せず、`<base>` はシムより前に効く。

このため `rewriteHtml` は次の方針で `<base href>` を処理する。

- **再ベース**: 文書内の最初の `<base href>`（HTML 仕様上、有効なのは最初の 1 つ）を `baseUrl` 基準で解決し、http(s) に解決できる場合はその値を以降の全書き換えの**実効解決基点（effectiveBase）**として用いる。これにより `<base>` 指定サイトでも相対 URL を著者の意図どおりに解決する。
- **除去**: 解決基点を取り込んだうえで、すべての `<base>` 要素から `href` 属性を除去する。除去後はブラウザが文書 URL（= プロキシの `/browse/...`）を基準に解決するため枠内に留まる。`target` 等の他属性は保持する。
- **http(s) 以外**: `<base href>` が http(s) に解決できない場合は effectiveBase に採用せず `baseUrl` を用いる（`href` 除去は行う）。

### srcset の書き換え

`<img>` / `<source>` の `srcset` 属性は、`url [記述子]` のカンマ区切りリスト（記述子は `1x` / `2x` の画素密度、または `640w` の幅）。`src` だけを書き換えて `srcset` を放置すると、ブラウザは `srcset` 側の候補を優先採用し、**書き換え前の URL** で取得してしまう。特にプロキシ対象が Next.js 製サイトの場合、`<Image>` が出力する `srcset="/_next/image?url=<外部>&w=256 1x, …"` がそのまま残り、プロキシ origin 直下の `/_next/image`（=プロキシ自身の画像最適化エンドポイント）へ解決され、外部ドメインが `images.remotePatterns` 未許可のため **400** になる（#98）。

これを防ぐため、`rewriteHtml` は `<img>` / `<source>` の `srcset` を各候補に分解し、URL 部のみを `assetUrl()`（`<img src>` と同じパス反映形式 `/api/proxy/<scheme>/<host>/<path>` 化）で書き換え、**記述子（`1x` / `640w` 等）はそのまま保持**して再結合する。

- **候補の分割**: WHATWG の srcset 解析に準じ、URL 部は空白以外の連続文字として取り出す（`data:` URL 内のカンマで誤分割しない）。URL 直後の記述子はカンマまでを保持する。
- **http(s) 以外**: `assetUrl` と同じく、`data:` URL や http(s) に解決されない値はそのまま残す。

### サブリソース整合性（SRI）属性の除去

`<script src>` をパス反映形式 `/api/proxy/<scheme>/<host>/<path>` へ書き換えると、ブラウザが実際に取得するのは**プロキシが中継したレスポンス**になる。元の `src` に `integrity`（SRI）属性が付いている場合、中継レスポンスは元 URL のバイト列と一致する保証がなく（ヘッダーサニタイズ・エンコーディング差異等）、**SRI ハッシュ不一致でスクリプトの実行がブロック**される。これを防ぐため、`src` を書き換える `<script>` からは `integrity` 属性を除去する。

- **対象**: `src` を書き換える `<script src>`。同時に `crossorigin` 属性も除去する（書換後は同一 origin の `/api/proxy` 経由となり、CORS モード指定が不整合・不要になるため）。
- **対象外**: `src` を持たないインライン `<script>`、および `img` / `link` 等の他タグ（現状 SRI の実害が観測されていないため最小限に留める）。
- **背景**: Google の enable JavaScript インタースティシャル等、SRI 付きスクリプトでチャレンジ JS をロードするサイトで、`solveSimpleChallenge is not defined` 等の未定義エラーを誘発し得る要因の一つ（Issue #67 / 調査 #52）。

### meta refresh の書き換え

`<meta http-equiv="refresh" content="<遅延>;url=<TARGET>">` の `url` を `<a href>` と同様にパス反映ナビ形式 `/browse/<scheme>/<host>/<path>` へ書き換える。これを行わないと、`url=/...`（ルート相対）の meta refresh が、閲覧ページではなく**プロキシ自身のオリジン直下**へ解決され、プロキシから離脱してしまう（例: `<meta http-equiv="refresh" content="3;url=/login">` のような遅延付き自動遷移）。

- **判定**: `http-equiv` の値は大文字小文字を無視して `refresh` と一致するものを対象とする。
- **解析**: `content` を `<遅延>;url=<TARGET>` として解釈し、`url=` の前後空白・大文字小文字・クォート（`'` / `"`）を許容する。遅延値はそのまま保持する。
- **書き換え対象**: `url=` が示すターゲットを `baseUrl` 基準で絶対 URL に解決し、http/https に解決される場合のみパス反映ナビ形式へ書き換える（`<a href>` と同じ `browseUrl()` の挙動に準拠。http(s) 以外はそのまま）。
- **対象外**: `url` を持たない純粋な遅延 refresh（例 `content="5"`、自ページ再読み込み）は書き換えず素通しする。

> **制限**: パーサ（`node-html-parser`）は `<noscript>` の内側を生テキストとして扱うため、**`<noscript>` 内の meta refresh は書き換えられない**。JS 有効ブラウザは `<noscript>` 内容を無視するため実害はないが、この書き換えは**プロキシオリジンへの離脱防止が目的**であり、Google 検索の「enable JavaScript」インタースティシャル（meta refresh が noscript 内・実駆動は JS の自己再ナビゲーション）による無限ループは**本書き換えの対象外**である。この無限ループ自体は別途 [ナビゲーションループの検出](#ナビゲーションループの検出enablejs-対策) で検出し、案内ページへ切り替えて停止させる。

### inline CSP（meta）の除去

レスポンスヘッダーの `Content-Security-Policy` は[ヘッダー処理](#レスポンスヘッダー処理)で除去するが、HTML 内に `<meta http-equiv="Content-Security-Policy" content="...">` で**インライン指定された CSP** はヘッダーサニタイズでは消せない。これが残ると、`rewriteHtml` が注入する各種スクリプト（アドレスバー・GET フォーム横取り・クリック横取り・SW 登録・`document.domain` シム。いずれも nonce 無し）や、`/api/proxy` へ書き換えた `src` が CSP 違反で**ブロック**され得る。これを防ぐため、`rewriteHtml` は inline の CSP meta を除去する。

- **判定**: `http-equiv` の値を大文字小文字を無視して照合し、`content-security-policy` に一致する `<meta>` を除去する。
- **対象外（素通し）**: `Content-Security-Policy-Report-Only` は実際のブロックを行わずレポートのみのため除去しない（`http-equiv` が `content-security-policy-report-only` のものは残す）。
- **対象外**: `<meta http-equiv="refresh">` 等、CSP 以外の meta は影響を受けない。
- **背景**: A1（SRI 属性除去）と同じく、注入スクリプトや書換 src のブロックを防ぐ汎用堅牢化（Issue #67 / 調査 #52）。

### GET フォーム送信の横取り

パス反映ナビ形式（#115）では `<form action>` が `/browse/<scheme>/<host>/<path>?<targetクエリ>` となり、GET 送信でブラウザが破棄するのは**クエリ部のみ**でターゲット（host/path）は**パス部に残る**ため、原理的には `GET /browse/<scheme>/<host>/<path>?<form 項目>` として正しいターゲットに届く（旧 `?url=` 方式では `url=` がクエリにあり消失していた問題が、パス反映により構造的に解消される）。ただし **SPA（React 等）が自前の submit ハンドラで実サイトへ後勝ち遷移する**問題（#93）は残るため、横取りスクリプトは引き続き注入する。

これを補うため、`rewriteHtml` は閲覧ページの `<body>` 直後（アドレスバー・SW 登録に続けて）に **GET フォーム送信を横取りするスクリプト**を注入する。挙動は以下のとおり。

| 条件                                     | 処理                                                                                                                                                                                                                                                                    |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET フォームの送信                       | `submit` を `preventDefault` + **`stopImmediatePropagation`**（SPA の自前 submit ハンドラを阻止）し、ターゲットのクエリにフォーム項目をセットしてパス反映ナビ形式 `/browse/<scheme>/<host>/<path>?<再構築>` へ遷移する                                                  |
| GET フォーム内 input での Enter キー押下 | `keydown`(Enter) を**キャプチャで捕捉**し、サイト独自の keydown ハンドラより先に `preventDefault` + `stopImmediatePropagation` して、上記 GET フォーム送信と同じ振り向けロジックでパス反映ナビ形式へ遷移する（`submit` イベントを発火させずに遷移するサイト対策・#164） |
| POST フォームの送信                      | 横取りせず素通し                                                                                                                                                                                                                                                        |

- **ターゲットの復元**: 送信フォームの `action`（書き換え済み `…/browse/<scheme>/<host>/<path>`）のパス反映マーカー以降からターゲットを復元する。`action` に含まれない（=`action` 属性なしのフォーム等）場合は、閲覧ページ自身の URL（`window.location`）から復元する。後方互換として、リダイレクト前の `…/browse?url=<target>` 形式の `action` / 閲覧ページでは `url=` パラメータから復元する。
- **クエリの載せ替え**: 復元したターゲットの**クエリ全体**をフォーム項目（`FormData`）で置き換える。これは GET フォーム送信時のブラウザ本来の挙動（action のクエリを破棄してフォーム項目に差し替え）をプロキシ経由で再現するもの。
- **BASE_PATH の保持**: 遷移先は `action`（または `window.location`）の**パス部をそのまま再利用**するため、リバースプロキシのパスプレフィックス（`BASE_PATH`、例 `/proxy/3000`）込みの `…/browse` パスが保持される。
- **動的フォーム対応**: `document` への `submit` イベント委任（キャプチャ）で捕捉するため、JS が実行時に追加したフォームにも効く。
- **SPA 自前 submit ハンドラの阻止（#93）**: SPA（React 等）は GET 検索フォームの `submit` を**自前ハンドラ（バブル）で横取りし、`location` で実サイトへ直接遷移**させる（例 `www.yahoo.co.jp` トップの検索 → `search.yahoo.co.jp`）。注入スクリプトはキャプチャで先に発火するが、`preventDefault` だけでは伝播が止まらず後続のバブルハンドラが発火して**後勝ちでプロキシを離脱**する。そのため横取り時は **`stopImmediatePropagation()`** を呼んでバブルの自前ハンドラへ到達させず、確実にプロキシ経由フルナビゲーションにする（クリック横取りの[同方式](#クライアント側ナビゲーションの横取り)と対をなす）。
- **`form.submit()`（プログラム送信）の捕捉（#78）**: `HTMLFormElement.prototype.submit()` は `submit` イベントを**発火しない**ため、上記のイベント委任では捕捉できない（例: Google 検索は `form.submit()` で送信する）。これを補うため、`HTMLFormElement.prototype.submit` を**オーバーライド**し、同じ振り向けロジック（`buildGetFormDestination`）を適用する。`form.submit()` 呼び出し時点では action に `?url=<target>` が残っているため正しい URL を復元できる。GET でない／復元不可（`buildGetFormDestination` が `null`）／自前アドレスバーのフォーム、および例外時は**元の `submit` をそのまま呼ぶ**（挙動を変えない）。`requestSubmit()` は `submit` イベントを発火するため、イベント委任側で従来どおり捕捉する（オーバーライド不要）。
- **Enter キー押下による遷移の捕捉（#164）**: サイトによっては、検索 input での Enter 押下を**自前の `keydown` ハンドラで処理し、`submit` イベントも `form.submit()` も介さずに `location.href`（実サイト絶対 URL）への直接代入で遷移**する（例 `www.yahoo.co.jp` トップ検索 → `search.yahoo.co.jp`。`location` 系は[改変不能](#クライアント側ナビゲーションの横取り)のためフックできない）。この場合は submit 横取り（#93）も `form.submit()` オーバーライド（#78）も空振りしてプロキシを離脱する。これを補うため、`document` への `keydown` イベント委任（**キャプチャ**）で **Enter キー**を捕捉し、フォーム内 input での Enter であればサイトの keydown ハンドラより先に `preventDefault` + `stopImmediatePropagation` して、`buildGetFormDestination` でパス反映ナビ形式へ遷移する。誤捕捉を避けるため、(1) IME 変換中（`isComposing` / `keyCode === 229`）・修飾キー併用は素通し、(2) `textarea`（改行入力）や送信を伴わない input 型（`button` / `submit` / `reset` / `checkbox` / `radio` / `file` / `image`）は対象外、(3) フォームに属さない input・自前アドレスバーは対象外とする。
- **絶対クロスオリジン `action` の直接 proxify（#164）**: React 等のハイドレーションで `<form action>` がサーバー書き換え済みのパス反映 URL から**実サイトの絶対 URL（プロキシ閲覧ページと別オリジン）へ復元**される場合がある。`buildGetFormDestination` は、`action` がパス反映／後方互換のいずれの proxy ナビ URL でもなく、かつ閲覧ページ（プロキシ）と**別オリジンの絶対 http(s) URL** のときは、その URL 自体を実ターゲットとして直接 proxify する（閲覧ページ origin へフォールバックして誤ったホストへ送らない）。振り向け先プレフィックス（`BASE_PATH` 込みの `…/browse/`）は閲覧ページ URL から導出する。
- **自前 UI の除外**: プロキシ自身のアドレスバー（`#proxy-addressbar` 内のフォーム）は独自の `onsubmit` で遷移を行うため、横取り対象から除外する（横取りすると入力 URL が無視され得る）。イベント委任・`submit()` オーバーライドの双方で除外する。
- **対象は GET のみ**: POST / その他メソッドは介入しない。GET フォーム以外の遷移は SW（下記）やサーバー側書き換えが担当する。
- **スコープ外**: フォームを介さない純粋な JS ナビゲーション（フォーム要素と無関係に `location.assign` / `location.href` / `history.pushState` で完成済み URL へ直接遷移する経路）は引き続き対象外。フォーム内 input での Enter 押下による `location.href` 直接遷移は上記の `keydown` 横取り（#164）で救済するが、フォームに紐づかない遷移は救済できない。

### クライアント側ナビゲーションの横取り

`rewriteHtml` の `<a href>` 書き換え（[書き換えルール](#書き換えルール)）は**サーバーが受信した初期 HTML を一度書き換えるだけ**で、JS（React 等）が**ページ読み込み後に動的描画した `<a href>`** は対象外となる。これらは生のターゲット URL（例 `https://news.yahoo.co.jp/articles/…`）のまま残り、クリックするとトップフレームのナビゲーションが**実サイトへ直行してプロキシから離脱**する。SW はナビゲーション（`request.mode === "navigate"`）を素通しし、かつ遷移先は別オリジンで SW スコープ外のため横取りもできない（[§Service Worker](#service-worker-による実行時リクエスト横取り)）。JS 主導でリンクを描画する SPA 系サイト（例 `www.yahoo.co.jp` トップのニュース記事リンク）で顕在化する。

さらに、SPA（React 等）は `<a>` クリックを **自前の onClick ルーターで横取りし、`history.pushState` で実サイトのパスへ遷移**させる（例 `news.yahoo.co.jp` トップ → 個別記事）。サーバー書き換え済みの `href` があっても、ルーターがクリックを奪うとプロキシから離脱する。`location` / `history` API 自体はブラウザ仕様で改変できず（`location.assign` / `location.href` setter / `window.location` はいずれも上書き不能。[#82](https://github.com/f8924919/web-proxy/issues/82) で実機確認）フックでは防げないため、**クリックの主導権を奪う**方式で対処する。

これを補うため、`rewriteHtml` は閲覧ページの `<body>` 直後（GET フォーム横取りに続けて）に **クリックによるナビゲーションを横取りするスクリプト**を注入する。`document` への `click` イベント委任（**キャプチャ**）で捕捉するため、JS が実行時に追加したリンクにも効き、かつ SPA ルーターの onClick（バブル）より**先に**発火する。

| 条件                                                               | 処理                                                                                                                                                              |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<a>`（祖先含む）への通常クリックで遷移先が proxy 中継対象（下記） | `preventDefault` + **`stopImmediatePropagation`**（SPA ルーターの横取りを阻止）し、`${BASE_PATH}/browse/<scheme>/<host>/<path>` へ `location.href` で遷移（#115） |
| 上記以外（下記スコープ外）                                         | 横取りせず素通し                                                                                                                                                  |

振り向け先は純粋関数 `buildClickNavDestination(href, pageUrl)` が決める。クリックされた `<a>` の `href` を現在の閲覧ページ URL を基準に解決し、次のとおり中継先を組み立てる（`null` なら素通し）。

振り向け先は §プロキシ URL スキームのパス反映ナビ形式 `${BASE_PATH}/browse/<scheme>/<host>/<path>` で組み立てる（#115）。閲覧ページの現ターゲットは、パス反映 URL（`location.pathname` の `/browse/` マーカー以降）から復元する。後方互換として、リダイレクト前の `…/browse?url=<target>` 形式の閲覧ページでは `url=` パラメータからも復元する。

- **外部オリジンの絶対 URL**（`http(s)://…`・プロトコル相対 `//host/…` を含む）: その絶対 URL をパス反映ナビ形式へ振り向ける。
- **ルート相対 / 相対 URL**（`/articles/…`, `foo/bar`, クエリのみの相対 `?q=…`）: **現ターゲットを基準に解決し直し**、その絶対 URL をパス反映ナビ形式へ振り向ける。パス反映の閲覧ページではクエリのみの相対（`?q=…`）はブラウザのネイティブ解決で既に正しい `…/browse/<scheme>/<host>/<path>?q=…` に着地するが、横取りでも同一の結果へ正規化する。
- **既に書き換え済みの proxy browse リンク**（同一オリジンで、パス反映ナビ形式＝`/browse/<scheme>/<host>/…`、または後方互換の `…/browse` パス**かつ `url=` パラメータを持つ**）: その URL へ**フルナビゲーション**させる（`location.href` で遷移）。これにより SPA ルーターがクリックを奪って `history` 遷移する前に、確実に proxy 経由で読み込み直す。後方互換形式で `url=` の有無を要するのは、ターゲット側 SPA のクエリのみ相対リンク（DuckDuckGo「Searches related to」の `?q=…`）が `…/browse` パスへ解決され `url=` を持たないまま素通しされてプロキシが外れるのを防ぐため（[#114](https://github.com/f8924919/web-proxy/issues/114)）。
- **BASE_PATH の保持**: 振り向け先のパス反映プレフィックス（`${BASE_PATH}/browse/`）は現在の閲覧ページ URL（`window.location`）から再利用する（GET フォーム横取りと同方式）。
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

`<form action>` は `rewriteHtml` によりメソッドを問わずパス反映ナビ形式 `…/browse/<scheme>/<host>/<path>` へ書き換えられる（[HTML 書き換え](#html-書き換え)・#115）。POST フォームはターゲットが action の**パス部**に載るため、追加の横取りスクリプトなしに `POST …/browse/<scheme>/<host>/<path>` としてパス反映ルートの POST ハンドラへ届く（GET フォーム横取りスクリプトは非 GET を素通しする）。`action` 属性を持たない POST フォームは閲覧ページ自身（パス反映 URL）へ送信されるため、同じく正しいターゲットへ中継される。

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
url("/api/proxy/<scheme>/<host>/<path>")
```

`@import` も同様にパス反映形式（[§プロキシ URL スキーム](#プロキシ-url-スキームパス反映)）へ変換する。

---

## JavaScript

**JS ソースコード自体の書き換え（AST パース）は行わない。** 実装コスト・壊れやすさのリスクが高く、スコープ外とする。

代わりに、JS が実行時に発行するリクエストを **Service Worker（SW）で横取り**して `/api/proxy` 経由へ振り向ける（下記）。

### Service Worker による実行時リクエスト横取り

JS 依存サイト（Google 等）では、画像・スクリプト・XHR などがサーバー側の HTML 書き換え後に **JS が実行時に動的ロード**するため、`rewriteHtml` の属性書き換えだけでは捕捉できず、相対/絶対 URL がプロキシ origin やターゲット origin へ直接飛んで 404 / CORS エラーになる。これを補うため、閲覧ページに SW を登録し、ページ内のリクエスト（**ページ遷移ナビゲーションを除く全メソッド**）を横取りして書き換える。

| リクエスト種別                                                                                                       | 横取り後                                                                                                                                                                                |
| -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| クロスオリジンの絶対 URL（例 `https://ssl.gstatic.com/...`）                                                         | `/api/proxy/<scheme>/<host>/<path>`（[§プロキシ URL スキーム](#プロキシ-url-スキームパス反映)）                                                                                         |
| 同一オリジンのルート絶対パス（例 `/images/x.png`、`/xjs/...`）                                                       | ターゲット origin に解決し `/api/proxy/<scheme>/<host>/<path>`                                                                                                                          |
| 同一オリジンの `/_next/image`（ターゲットが Next.js 製の画像最適化エンドポイント）                                   | ターゲット origin に解決し `/api/proxy/<scheme>/<host>/_next/image?...`（下記参照。#102）                                                                                               |
| 自前ルート（`/browse`・`/api/proxy/*`・`/_next/*`〔`/_next/image` を除く〕・`/sw.js`・`/favicon.ico`・ホーム `/`）   | 横取りせず素通し（パス反映済みの相対 import `/api/proxy/<scheme>/<host>/<path>` もここで素通しされ、ルートが中継する。#100）                                                            |
| トップレベルのページ遷移ナビゲーション（`request.mode === "navigate"` かつ `destination` が `document`）             | 横取りせず素通し（サーバー側書き換え・[クライアント側ナビゲーション横取り](#クライアント側ナビゲーションの横取り)・フォーム送信に委ねる）                                               |
| サブフレーム（`<iframe>`）のナビゲーション（`request.mode === "navigate"` かつ `destination` が `iframe` / `frame`） | ターゲット origin に解決し `/browse/<scheme>/<host>/<path>` へ **302 リダイレクト**（[§サブフレーム（iframe）ナビゲーションの横取り](#サブフレームiframeナビゲーションの横取り160162)） |

- **対象メソッド**: ナビゲーションを除き **GET / POST / PUT / PATCH / DELETE** を横取りする（[§CORS プリフライト対応](#cors-プリフライト対応) のため非 GET も同一オリジンの `/api/proxy` へ振り向ける）。非 GET の振り向けではメソッド・ボディ・リクエストヘッダーを保持する。
- **ターゲット origin の特定**: SW は `fetch` イベントの `clientId` から要求元ページの URL を取得し、`extractTarget` でターゲットを復元する（パス反映 `/browse/<scheme>/<host>/<path>`・後方互換 `/browse?url=<target>` の両対応。#115）。
- **`/_next/image` の扱い（#102）**: `/_next/*` は原則プロキシ自身の資産（`/_next/static` のチャンク等）として素通しするが、`/_next/image` だけは例外とする。プロキシ対象が Next.js 製サイトの場合、クライアントの hydration が `<Image>` の `srcset` を実行時に再生成し、`/_next/image?url=<外部>` を**プロキシ origin 直下**へ要求する。これを素通しするとプロキシ自身の画像最適化エンドポイントに当たり、外部ドメインが `images.remotePatterns` 未許可で **400** になる（サーバー描画分の `srcset` 書き換えは #98 で対応済みだが、クライアント再生成分はこの SW 経路でしか救えない）。そこで `/_next/image` は自前ルートから除外し、**ターゲット origin の `/_next/image`**（=ターゲット自身の最適化エンドポイント）へ解決して `/api/proxy` 経由で中継する。ターゲットを特定できないページ（ホーム等、`url` パラメータ無し）では従来どおり素通しし、プロキシ自身の `/_next/image` 利用には影響しない。
- **ランタイム相対 module import（#100）**: チャンク分割 SPA がランタイムで発行する相対 import（`import('./chunk.js')`）は、エントリ JS がパス反映形式（`/api/proxy/<scheme>/<host>/<path>`）で配信されるため、ブラウザがモジュールのディレクトリを基準にネイティブに正しく解決する。解決結果も `/api/proxy/<scheme>/<host>/<path>`（自前ルート）となり、SW は素通ししてルートが中継する。これによりクエリ方式時代の「`…/api/chunk.js` への誤解決 → 404・MIME エラー」が解消する（[§プロキシ URL スキーム](#プロキシ-url-スキームパス反映)）。
- **残存制約（クロスオリジン module からのルート絶対参照）**: クロスオリジンのチャンクが発行する**ルート絶対**参照（`/y.js`）は、ブラウザがプロキシ origin 直下に解決し、SW は referrer 不在のため**ページ target の origin**に振り向ける（モジュール自身の origin ではない）。同一 origin のチャンク内参照・絶対 URL は正しく振り向く。
- **配信と適用範囲**: SW は `public/sw.js` で配信し、登録スコープは `${NEXT_PUBLIC_BASE_PATH}/`。リバースプロキシのパスプレフィックスは SW 自身の登録スコープ（`self.registration.scope`）から導出する。詳細は [arch/proxy.md §Service Worker](../../arch/proxy.md#service-worker-publicswjs)。

### サブフレーム（iframe）ナビゲーションの横取り（#160・#162）

JS が実行時に動的生成した `<iframe>` の `src` に **root 相対パス**（例 `/player/xtv3w.html`）や絶対 URL が設定されると、その iframe ドキュメント要求は `request.mode === "navigate"` になる。トップレベル遷移と同じく素通しすると、root 相対パスは**プロキシ自身の origin** に解決されて **404** になり（実測: Dailymotion のプレイヤー埋め込み iframe）、サーバー側 HTML 書き換え（静的 `<iframe src>` のパス反映化）・fetch/XHR シム・クリック横取りのいずれもランタイム生成 iframe を捕捉できない。

これを補うため、SW は **`destination` が `iframe` / `frame`（サブフレーム）の navigate のみ**横取りし、ターゲット origin 基準で解決した `/browse/<scheme>/<host>/<path>` へ **302 リダイレクト**する。リダイレクト先は自前ルート（`/browse`）なので、iframe はブラウズ中継経路で読み込まれ、本文の中継・書き換え・SW 登録・シム注入がフル適用され、iframe 内部の相対 URL も正しく解決される。

| サブフレーム navigate の src                                                        | 横取り後                                                                              |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| 同一オリジンの root 相対パス（`/player/...`）                                       | 閲覧ページ URL からターゲット origin を復元し `/browse/<scheme>/<host>/<path>` へ 302 |
| クロスオリジンの絶対 URL（`https://other.example/...`）                             | `/browse/<scheme>/<host>/<path>` へ 302                                               |
| 自前ルート（`/browse`・`/api/proxy/*` 等）・非 http(s)（`about:blank`・`data:` 等） | 横取りせず素通し（リダイレクトの再帰・スキーム破壊を防ぐ）                            |

- **トップレベル遷移は不変**: `destination` が `document` のナビゲーションは従来どおり素通しし、既存挙動（サーバー側書き換え・クライアント側ナビゲーション横取り・フォーム送信）を変えない。
- **ターゲット origin の特定**: SW の `fetch` イベントの `clientId`（無ければ `referrer`）から親ページ URL を取得し、`extractTarget` でターゲットを復元する（既存の subresource 横取りと同方式）。ページ URL からターゲットを復元できない場合は素通しする（従来挙動へフォールバック）。
- **再帰防止**: リダイレクト先 `/browse/...` は自前ルートのため、再度の iframe navigate では横取り対象外となり素通しされる。
- **限界**: 初回ロードで SW が未制御の段階で生成される iframe は捕捉できない（SW 制御確立後のランタイム生成が主対象）。

### 実行時リクエスト横取りシム（SW 非依存・#124）

SW は登録後 `clients.claim()` で既存クライアントを制御下に置くが、**初回ロードでは claim 完了前に開始したサブリソース要求を横取りできない**。このため初回表示時、JS が発行する `fetch` / XHR が取りこぼされる: 同一オリジンのルート絶対パス（例 `/api/personalized-articles`・`/cb_pc.gif`）はプロキシ origin に着地して **404**、クロスオリジン XHR（例 `https://*.yahooapis.jp/...`）は直アクセスして **CORS で失敗**する。とりわけブラウザバック中継（`PROXY_BROWSER_MODE`）では、配信 DOM がクライアントで動的データを**再取得**するため顕在化し、動的セクション（例 `news.yahoo.co.jp` の「あなたにおすすめ」）が欠落する。

これを補うため、`rewriteHtml` は `<head>` 最先頭（ページ内スクリプトより先）に **`window.fetch` と `XMLHttpRequest.prototype.open` を上書きする横取りシム `<script>`** を注入する。SW の制御確立を待たず、リクエスト URL を SW と**同一の規則**で `/api/proxy/<scheme>/<host>/<path>` へ書き換える。

| リクエスト種別                                                                                                                               | シムの書き換え後                                                                    |
| -------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| クロスオリジンの絶対 URL                                                                                                                     | `/api/proxy/<scheme>/<host>/<path>`                                                 |
| 同一オリジンのルート絶対パス（`/path`）                                                                                                      | 閲覧ページ URL からターゲット origin を復元して `/api/proxy/<scheme>/<host>/<path>` |
| 自前ルート（`/browse`・`/api/proxy/*`・`/_next/*`〔`/_next/image` を除く〕・`/sw.js`・`/favicon.ico`・ホーム `/`）・非 http(s)（`data:` 等） | 横取りせず素通し                                                                    |

- **SW との非競合・冪等**: シムが書き換えた先は同一オリジンの `/api/proxy/...`。SW が制御中でも、SW はこれを自前ルートと判定して素通しするため**二重書き換えにならない**。判定規則（自前ルート・ターゲット復元）は SW（`public/sw.js`）と揃える（純粋関数を共有できないため rewrite.ts 側に同等ロジックを持つ。差分が出ないよう両者を対で保守する）。
- **対象 / スコープ外**: ナビゲーション（`location` 代入・フォーム送信）は対象外（[クライアント側ナビゲーション横取り](#クライアント側ナビゲーションの横取り)・[GET フォーム送信の横取り](#get-フォーム送信の横取り)・サーバー書き換えに委ねる）。`fetch(Request)` 形式は `Request` の URL を書き換えて再構築する。非 GET はメソッド・ボディ・ヘッダーを保持する。同一オリジン化により[CORS プリフライト](#cors-プリフライト対応)も発生しない。
- **位置づけ**: SW を置き換えるものではなく、初回ロードの制御ギャップを埋める**フォールバック**。SW 制御が確立した以降のリクエストは従来どおり SW でも横取りされる（結果は同一）。

---

## CORS プリフライト対応

JS アプリが発行するクロスオリジンの `fetch` / XHR（非単純メソッド・カスタムヘッダー・`application/json` POST 等）は、本来ブラウザがターゲット origin へ **CORS プリフライト（`OPTIONS`）** を飛ばし、ターゲットがプロキシ origin を許可しないため失敗する。

### 方針: プリフライトを「消す」

プリフライトは**クロスオリジン**リクエストでのみ発生する。SW がこれらのリクエストを**同一オリジンの `/api/proxy`（パス反映形式）へ振り向ける**と、ブラウザから見て同一オリジンになり**プリフライト自体が発生しない**。実際のクロスオリジン取得はサーバー側（`/api/proxy`）が行う（サーバー間通信は CORS の対象外）。

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
- **`Cookie` はサーバー側 jar から復元**: 転送する `Cookie` は、`forwardableRequestHeaders` / `relayRequestHeaders` の両方で**ブラウザ受信分を使わず**、`__pxy_sid` セッション × 現ターゲット origin で jar から復元した分だけを載せる（[§サイト間 Cookie アイソレーション](#サイト間-cookie-アイソレーション)）。ブラウザの `Cookie`（`__pxy_sid` / `__pxy_auth` 等プロキシ自身の Cookie）は上流へ転送しないため、インフラ認証 cookie（`CF_Authorization` 等）も漏れない。jar に保持分が無ければ `Cookie` ヘッダー自体を付けない。

### セキュリティ上の制約

- **転送ヘッダーのハードニング（#27 対応済み）**: 非 GET 中継は拒否リスト方式で広めに転送するが、`Cookie` はブラウザ受信分を転送せず jar から現ターゲット origin 分のみを復元し（[§サイト間 Cookie アイソレーション](#サイト間-cookie-アイソレーション)）、プロキシ自身の文脈を漏らす `origin` / `referer` は除外する。`Authorization` は `Set-Cookie` のようなサーバー側往復機構が無くスコープ鍵を付与できないため、**中継元ページのオリジンが宛先ターゲット origin と一致する場合のみ**転送する（[§Authorization のオリジンスコープ](#authorization-のオリジンスコープ136)。#136）。
- **CORS 許可オリジンの制限（#27 対応済み）**: `OPTIONS` 応答・中継レスポンスの `Access-Control-Allow-Origin` は、要求 `Origin` がリクエスト自身の Host と同一オリジンの場合のみエコーする（純粋関数 `allowedCorsOrigin`）。第三者クロスオリジンへ無検証エコー＋`Allow-Credentials` を返さない。SW の同一オリジン化により正当なクライアントは常に自プロキシ origin であり、回帰は無い。
- **`credentials` の扱い**: SW は振り向け時に `credentials: "same-origin"` を用いる（振り向け先は常に同一オリジンの `/api/proxy`）。これにより、プロキシ自身が認証プロキシ（Cloudflare Access 等）の背後にある場合でも、プロキシ origin の認証 cookie（`CF_Authorization` 等）と `__pxy_sid` が `/api/proxy` へ届き、プロキシ自身の認証通過と jar 参照が成立する（`omit` だと未認証とみなされログインページへ 302 され CORS で失敗していた）。届いたブラウザ Cookie 自体は上流へは転送しない（[§サイト間 Cookie アイソレーション](#サイト間-cookie-アイソレーション)）。

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

| 方向                  | 処理                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ブラウザ → ターゲット | `Cookie` は**サーバー側 jar から復元**して転送する（ブラウザの `Cookie` ヘッダーは上流へ転送しない）。`__pxy_sid` セッション × 現ターゲット origin で jar を引き、保持中の中継 Cookie だけを送る（[§サイト間 Cookie アイソレーション](#サイト間-cookie-アイソレーション)）。`Authorization` は**中継元ページのオリジンが宛先ターゲット origin と一致する場合のみ**転送する（[§Authorization のオリジンスコープ](#authorization-のオリジンスコープ136)）。全リクエストヘッダーの素通しはしない |
| ターゲット → ブラウザ | `Set-Cookie` は**ブラウザへ返さず**、`Domain` を無視してサーバー側 jar へ origin 別に格納する（[§サイト間 Cookie アイソレーション](#サイト間-cookie-アイソレーション)）。クライアントへ返すプロキシ Cookie は不透明なセッション ID `__pxy_sid` のみ                                                                                                                                                                                                                                           |

- **対象ハンドラ**: `/browse`（`GET` / `POST`）と `/api/proxy`（`GET`）の両方で転送する。認証が要る画像・CSS・JS（アセット）も取得できるようにするため、アセット中継にも付与する。
- **往復の成立**: 上流の `Set-Cookie` はサーバー側 jar に保持され、以降のリクエストでは `__pxy_sid` セッション × ターゲット origin に一致する分を jar から復元してターゲットへ戻す。これにより認証セッションが維持される。Cookie はクライアントへ返さないため `document.cookie` に中継先の Cookie が現れない（#151 Phase 1）。

### サイト間 Cookie アイソレーション

URL 書き換え方式のため、すべての中継先は**単一のプロキシ origin** から配信される。素朴に Cookie を中継すると、プロキシ origin に集約された Cookie が中継先を問わず送出され、あるサイトの Cookie が別サイトの中継リクエストに乗る（クレデンシャル混在・漏えい）。さらに Cookie をブラウザへそのまま返すと、`document.cookie` から中継先サイトの Cookie が読み取れてしまう（[§サイト間アイソレーションの構造的制約](#サイト間アイソレーションの構造的制約131) の脅威 (a)）。これを防ぐため、**中継 Cookie をクライアントへ返さず、サーバー側の Cookie jar（インメモリ）へ origin 別に保持**する（#151 Phase 1）。

- **セッション識別**: jar を引くためのセッション ID Cookie `__pxy_sid`（`HttpOnly; SameSite=Lax; Path=<BASE_PATH || "/">`、値は `crypto.randomUUID()`）を 1 つだけクライアントへ発行する。これはプロキシ自身の Cookie であり中継先へは転送しない。中継先 Cookie のブラウザ保存物がこの不透明なセッション ID だけになるため、`document.cookie` から中継先の Cookie 名・値は読めない。
- **復路（Set-Cookie）**: 上流レスポンスの `Set-Cookie` はブラウザへ返さず（握り潰し）、`__pxy_sid` のセッション × **リダイレクト追従後の最終 URL の origin**（書き換え基準 `baseUrl` と揃える。#42）をキーに jar へ格納する。`Domain` は無視し、`Max-Age` / `Expires` は jar 内エントリの有効期限として解釈する（`Max-Age=0` 等の削除指示も反映）。
- **往路（Cookie）**: ブラウザから届く `Cookie`（`__pxy_sid` / `__pxy_auth` などプロキシ自身の Cookie のみ）は上流へ転送しない。代わりに `__pxy_sid` のセッション × 現ターゲット origin で jar を引き、保持中の中継 Cookie を `name=value` で組み立てて転送する。別 origin の Cookie は jar のキーが異なるため混在しない。
- **jar のライフサイクル**: インメモリ `Map`（`rateLimit.ts` 等と同じステートレス・単一プロセス前提）。セッションは最終アクセスからの TTL で失効し、上限超過・期限切れは GC で回収する。**プロセス再起動・複数インスタンス間では共有されない**ため、再起動・別インスタンス振り分け時はセッション喪失（中継先の再ログイン）が起こり得る。永続化・共有ストアはスケール時の将来課題。
- **インフラ認証 cookie**: プロキシ自身が認証プロキシ（Cloudflare Access 等）の背後にある場合に付与される cookie（`CF_Authorization` 等）は、往路でブラウザ `Cookie` を一切上流へ転送しないため**自動的に漏れない**（専用の除去処理は不要）。
- **既知の制約**:
  - **client-only Cookie は対象外**: 中継先 JS が `document.cookie` で直接設定する Cookie は HTTP `Set-Cookie` を経由しないため jar に入らず、従来どおりプロキシ origin の `document.cookie` に保存される（脅威 (a) の一部が残存）。サーバー発行の `Set-Cookie`（認証セッションの主経路）のみが本機能の対象。横取りシムによる回収は将来課題（[#151 スパイク](../../task/151-cross-site-isolation-spike.md)）。
  - 往路は origin 粒度で保持分を一律転送し、元 Cookie の `Path` による絞り込みは行わない。
  - 本機能の導入前にブラウザへ保存された旧 `__pxy.<鍵>.` 形式の Cookie は往路で上流へ転送しないため不活性化し、自然失効に任せる（明示削除はしない）。再ログインが必要になる場合がある。

### サイト間アイソレーションの構造的制約（#131）

すべての中継先が単一のプロキシ origin 上で実行されるため、ブラウザのオリジン境界によるサイト間分離が効かない構造的制約が残る（OWASP A01 / A05 / CWE-346）。脅威は 2 系統あり、現状の到達点は以下のとおり。

- **脅威 (a) `document.cookie` 露出**: 中継した悪性サイト（または XSS を受けた中継サイト）の JS が `document.cookie` から他サイトの中継 Cookie を読み取る経路。**サーバー発行の `Set-Cookie` は #151 Phase 1（サーバー側 jar・[§サイト間 Cookie アイソレーション](#サイト間-cookie-アイソレーション)）で塞いだ**（クライアントへ返さないため `document.cookie` に現れない）。ただし中継先 JS が `document.cookie` で直接書く **client-only Cookie は対象外**で、これらは引き続き同一オリジンの `document.cookie` で共有される（横取りシムによる回収は将来課題）。
- **脅威 (b) 同一オリジン fetch のセッション乗っ取り**: 同一プロキシ origin ゆえ、悪性サイト JS が `fetch('/api/proxy/https/victim/…')` を発行でき、被害サイト宛リクエストには jar の Cookie がサーバー側で自動付与される（`HttpOnly` でも起こる）。jar はリクエストの発行元サイトを識別できないため、**jar 化では解消されない**。これは #151 Phase 2（サブドメイン origin 分離）で構造的に解消する。
- **緩和策（#131 のスコープ）**: プロキシ自身の UI レスポンスに `X-Frame-Options: DENY` を付与してクリックジャッキングを防ぐ（[§プロキシ UI レスポンスのクリックジャッキング防止](#プロキシ-ui-レスポンスのクリックジャッキング防止131)）。これは UI の枠外埋め込みを塞ぐ最小緩和であり、サイト間分離そのものは解決しない。
- **運用上の前提**: Phase 1 で server-set Cookie の `document.cookie` 露出は塞いだが、脅威 (b)（および client-only Cookie 経由の (a)）は Phase 2 完了まで残る。**信頼できないサイトと、認証セッションを持つサイトを同一タブ（同一プロキシ origin）で併用しないこと。** 本質的な解決の方針は #151 で決定済み（**両者併用の段階導入**）。Phase 2 はサブドメイン origin 分離（ワイルドカード証明書・feature-flag）で同一オリジン fetch のセッション乗っ取りまで解消する。比較・方針の詳細とロードマップは [docs/task/151-cross-site-isolation-spike.md](../../task/151-cross-site-isolation-spike.md)（実装は Phase 別の別 Issue で進行）。

### Authorization のオリジンスコープ（#136）

`Cookie` と異なり `Authorization` には `Set-Cookie` のようなサーバー側往復機構が無く、サーバー側 jar でターゲット別に保持することができない。そのため Cookie と同方式の origin スコープ化はできないが、同一プロキシ origin 集約（[§サイト間 Cookie アイソレーション](#サイト間-cookie-アイソレーション)）のもとでは、ある中継サイトの JS が付与した `Authorization` が振り向け先次第で**別ターゲットへ流れる**経路になり得る（OWASP A01 / CWE-200）。これを塞ぐため、`Authorization` は**中継元ページのオリジンが宛先ターゲット origin と一致する場合のみ**転送する（条件付き転送）。

- **中継元オリジンの判定**: 受信リクエストの `Referer` を中継元シグナルとして用いる。`Referer` はプロキシ origin の URL で、そのパスにターゲットが反映されている（`/browse/<scheme>/<host>/…` または `/api/proxy/<scheme>/<host>/…`、後方互換の `/browse?url=…`）。ここから中継元ターゲットの絶対 URL を復元し、その `origin` を中継元オリジンとする。
- **一致判定**: 復元した中継元 origin が宛先ターゲット `origin`（`URL.origin` = `scheme://host[:port]`）と**完全一致**する場合のみ `Authorization` を転送する。スキーム・ホスト・ポートのいずれかが異なれば（サブドメイン違いを含む）転送しない。
- **fail-closed**: `Referer` が無い・パース不能・中継元ターゲットを復元できない場合は、判定不能として `Authorization` を**転送しない**（安全側）。トップレベル遷移（ユーザーのアドレスバー入力等）ではブラウザは `Authorization` を自動付与しないため、この除去による実害は通常生じない。
- **適用範囲**: `forwardableRequestHeaders`（`GET` / `/browse` POST）と `relayRequestHeaders`（非 GET 中継）の両方に適用する。判定は純粋関数で行い、判定材料（宛先 origin・受信 `Referer`）は呼び出し時点で両関数に渡る引数・受信ヘッダーから得る。
- **リダイレクト追従との関係**: 別オリジンへのリダイレクト追従時に `Authorization` / `Cookie` を除去する既存処理（[§リダイレクト追従](#リダイレクト追従)・#26）は引き続き有効で、本スコープは**初回中継**の入口で同等の保護を与える。
- **既知の制約**: 中継元判定は `Referer` に依存するため、`Referer` を抑止する設定（`Referrer-Policy: no-referrer` 等）下では同一オリジン宛の `Authorization` も fail-closed で除去され得る。これは安全側への倒し込みであり、Cookie ベース認証は影響を受けない。

### セキュリティ上の制約

- **リダイレクト追従時の漏えい（#26 で対応済み）**: かつて `proxyFetch` は `redirect: "follow"` 固定で、クロスオリジンへのリダイレクト時に `Authorization` / `Cookie` を追従先へそのまま送っていた。現在は `redirect: "manual"` 化して自前で追従し、**追従先が元リクエストと別オリジンなら `Authorization` / `Cookie` を除去**する（[§リダイレクト追従](#リダイレクト追従) 参照）。
- **`credentials` 付きクロスオリジン XHR（#28 対応済み）**: SW は非 GET 含むサブリソースを同一オリジンの `/api/proxy` へ振り向け（[§CORS プリフライト対応](#cors-プリフライト対応)）、振り向け `fetch` は `credentials: "same-origin"` を用いる。振り向け先が同一オリジンのため**`__pxy_sid` セッション Cookie が `/api/proxy` まで届き**、サーバー側 jar から**現ターゲット origin 分だけが復元されて上流へ転送される**。これにより `fetch(target, { credentials: "include" })` 相当の Cookie ベース・クロスオリジン XHR が、jar に保持された Cookie について成立する（[§サイト間 Cookie アイソレーション](#サイト間-cookie-アイソレーション)）。ブラウザの `Cookie` 自体は転送しないため、プロキシ自身のインフラ認証 cookie（`CF_Authorization` 等）は上流へは漏れない。
- **`credentials` 付き XHR の既知の制約**: SW は元リクエストの `credentials` モード（`omit` / `same-origin` / `include`）を区別せず一律 `same-origin` で振り向けるため、`credentials: "omit"` の XHR でも**当該ターゲット自身の jar 保持 Cookie が送られ得る**。ただし送信先は常に現ターゲット origin 分のみで、サイト間の Cookie 混在・漏えいは起きない（[§サイト間 Cookie アイソレーション](#サイト間-cookie-アイソレーション)）。また対象は jar に保持された Cookie に限り、プロキシ外で取得した Cookie は対象外。

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

## 中継本文のサイズ上限（メモリ枯渇 DoS 対策・#134）

HTML / CSS は URL 書き換え（`rewriteHtml` / `rewriteCss`）のために本文を**全量メモリへ展開**する必要がある。`Accept-Encoding: identity` 固定（[§レスポンスヘッダー処理](#レスポンスヘッダー処理)）で圧縮も効かないため、巨大なレスポンスを返す中継先を指定するだけでメモリ枯渇（OOM）を誘発できる（OWASP A04:2021 / CWE-400）。これを防ぐため、**全量バッファする本文（HTML / CSS）にバイト数上限**を設ける。

- **対象**: 書き換えのため全量読み込みが必要な **HTML（`/browse`）と CSS（`/api/proxy`）のみ**。画像・JS など書き換え不要なアセットは `res.body` を**ストリーム透過**で返し自プロセスにバッファしないため、本上限の対象外（メモリ枯渇の経路にならない）。
- **二段の判定**: ①応答の `Content-Length` が上限を超えると宣言していれば、本文を読む前に即座に打ち切る（早期判定）。②`Content-Length` が無い・過少申告の場合に備え、本文を**ストリームで読みながら実バイト数を加算**し、上限を超えた時点でストリームを `cancel` して打ち切る。
- **上限超過時の応答**: 本文を打ち切り、`413`（Payload Too Large）を返す。上流到達不能・タイムアウト等のゲートウェイ異常（`502`）とは区別する。
- **上限値**: 既定 **10 MiB**（`10 * 1024 * 1024` バイト）。環境変数 `PROXY_MAX_BUFFER_BYTES`（サーバー専用。`NEXT_PUBLIC_` 接頭辞なし）で上書きできる。正の整数以外・未設定は既定値を用いる。
- **ブラウザティアの事前検査（#144）**: ブラウザバック中継（`browserFetch`）は `page.content()` で描画済み DOM を文字列化した時点でメモリへ全量展開されるため、上記②のストリーム検査（`readTextWithLimit`）では「手遅れ」になる（巨大文字列はすでに常駐済み）。`browserFetch` のレスポンスには `Content-Length` も付かず①の早期判定も効かない。これを防ぐため、`page.content()` を呼ぶ**前**にブラウザ context 内で描画済み DOM の UTF-8 バイト数を概算し（`new TextEncoder().encode(document.documentElement.outerHTML).length`）、同じ上限（`PROXY_MAX_BUFFER_BYTES`）を超えるなら取得を打ち切って `413` を返す（中継ティアの挙動と揃える）。測定はブラウザプロセス内で行うため、Node プロセスへ巨大文字列を全量転送する前に未然に打ち切れる。詳細は [§browserFetch の振る舞い](#browserfetch-の振る舞い)。
- **ブラウザティア事前検査の限界（#144）**: 上記は**完全なストリーミング上限ではなく DOM 概算ベース**であり、(1) 概算値は `page.content()` の実シリアライズ結果と厳密一致しない（属性正規化・空白等で差が出る）、(2) 概算文字列の生成自体はブラウザプロセス内で一時的にメモリを使う（保護対象は Node プロセスのヒープ）、(3) `inlineCssomStyles`（#120）による CSSOM 実体化で増幅したサイズも測定対象に含む。測定 evaluate が失敗した場合は概算 0（上限内）とみなして続行し、展開後の `readTextWithLimit` を後段の安全網として残す。
- **既知の制約**: ストリーム透過アセットには本上限を適用しないため、巨大な単一アセットの**転送量**自体は制限しない（自プロセスのメモリは消費しないため OOM 脅威の対象外。転送量上限が必要なら別途検討）。タイムアウト（[§リダイレクト追従](#リダイレクト追従) の 10 秒）は引き続き全経路に効く。

---

## 中継本文の文字コード処理（#158）

HTML / CSS は URL 書き換えのため本文をバイト列から文字列へデコードする。デコード時に**応答が宣言する文字コードへ追従**しないと、EUC-JP / Shift_JIS など非 UTF-8 で配信される日本語サイト（例: livedoor ニュース）が文字化けする。中継本文のデコード（`readTextWithLimit`）は次の優先順で文字コードを判定し、判定結果でデコードする。

- **判定の優先順**: ①応答 `Content-Type` ヘッダーの `charset=` → ②（①が無い場合のみ）本文先頭バイトの sniff（HTML は `<meta charset>` / `<meta http-equiv="Content-Type">`、CSS は先頭の `@charset`）→ ③いずれも無ければ **UTF-8**。
- **デコード**: 判定した文字コードで本文をデコードして文字列を返す（Node 組込み `TextDecoder` を用いる。`euc-jp` / `shift_jis` / `iso-2022-jp` 等を標準サポートするため追加依存は不要）。
- **不正・未知ラベルのフォールバック**: 判定したラベルが `TextDecoder` で扱えない（未知・不正）場合は **UTF-8 にフォールバック**し、例外で中継を失敗させない。
- **出力**: 書き換え後の本文は常に UTF-8 として返す（`Content-Type: text/html; charset=utf-8` / `text/css; charset=utf-8`）。これによりレスポンスのバイト列と宣言 charset が一致する。
- **サイズ上限との関係**: バイト数の上限判定（[§中継本文のサイズ上限](#中継本文のサイズ上限メモリ枯渇-dos-対策134)）は**デコード前の生バイト列**で行うため、文字コード追従によって上限挙動（`413`）は変わらない。
- **既知の制約**: sniff は本文先頭の限られた範囲のみを対象とする簡易判定であり、`Content-Type` にも先頭にも宣言が無く本文後方でのみ charset を切り替えるような特殊なページは UTF-8 とみなす。

---

## オープンプロキシ乱用対策（#133）

本サービスは認証なしで誰でも任意の `http(s)` 先を中継できる**オープンプロキシ**であり、その性質上「開かれていること」は前提とする。一方で制御が皆無だと、踏み台・匿名化・スパム・違法コンテンツ中継の中継点になり得る（攻撃先から見た送信元 IP がこのサーバーになる。OWASP A04:2021 / CWE-441）。これを緩和するため、**既定では認証を課さず**次の最小対策を講じる。なお認証 / 接続元許可制の導入要否は [#148](https://github.com/f8924919/web-proxy/issues/148) で検討し、「**オープンであることを既定としつつ、制限環境向けに env で有効化できる任意の共有トークン認証を追加する**」方針とした（既定オフ・後方互換）。詳細は [§認証 / 接続元許可制（任意・#148）](#認証--接続元許可制任意148)。

緩和策は多層で構成する。

- **中継対象スキーム・ポートの制限**（下記）— 中継先を `http` / `https` の標準ポートに限定し、任意ポートへの踏み台利用を塞ぐ。
- **同時接続数の制限**（下記）— グローバル / IP 単位の同時処理数に上限を設け、短時間の大量同時接続による資源枯渇を抑止する。
- **[レート制限](#レート制限)**（既存）— IP 単位の単位時間あたり件数を制限する。
- **[SSRF 対策](#ssrf-対策)**（既存）— 内部 / メタデータ等への到達を遮断する。
- **abuse 申告窓口・利用規約** — 中継の悪用に対する申告経路と許容利用方針を README に明記する（[README §利用上の注意・乱用対策](../../../README.md)）。

### 中継対象スキーム・ポートの制限（#133）

> 関連アーキテクチャ: [arch/proxy.md §targetPolicy.ts](../../arch/proxy.md#srclibproxytargetpolicyts中継対象スキームポート制限133)。

中継先 URL の**スキームとポートを許可リスト方式で制限**する。許可外は中継せず `403`（Forbidden）を返す。

- **スキーム**: `http` / `https` のみ許可する。`ftp:` / `file:` / `gopher:` 等は拒否する。パス反映ルートの復元（`targetFromBrowsePath` / `targetFromProxyPath`）は元から非対応スキームを `null`（→ `400`）にするが、後方互換の `?url=` ルートやアセット中継入口でも改めてスキームを検証し、全経路で揃える。
- **ポート**: 既定で **80 / 443 のみ**許可する。ポート明示なしの URL はスキーム既定（`http`→80 / `https`→443）を補って判定する。`http://host:8080` のような非標準ポートは既定で拒否し、任意ポートを踏み台にしたポートスキャン・内部サービス探索を塞ぐ。
- **追加許可**: 環境変数 `PROXY_ALLOWED_PORTS`（サーバー専用。`NEXT_PUBLIC_` 接頭辞なし）にカンマ区切りでポート番号を列挙すると、既定の 80 / 443 に**追加**して許可する（例 `8080,8443`）。`1`〜`65535` の整数以外は無視する。既定（80 / 443）は常に許可され、env で外すことはできない。

### 同時接続数の制限（#133）

> 関連アーキテクチャ: [arch/proxy.md §concurrency.ts](../../arch/proxy.md#srclibproxyconcurrencyts同時接続数の制限133)。

[レート制限](#レート制限)（単位時間あたりの**件数**）と直交して、**同時に処理中の中継数**（同時接続数）にもインメモリで上限を設ける。短時間に大量の同時リクエストを送る乱用（並列での踏み台利用・資源枯渇）を、件数制限が効く前のバーストで抑止する。

- **二段の上限**: ①**グローバル**同時処理数の上限、②**IP 単位**の同時処理数の上限。中継処理の入口でスロットを 1 つ確保し、いずれかの上限に達していれば確保せず即座に打ち切る。
- **計上範囲**: スロットは**上流取得（`proxyFetch` / `browserFetch`）の開始からレスポンス構築までを計上**し、構築後に解放する。画像・JS 等のストリーム透過アセットの**本文転送中は計上しない**（接続確立とバッファ処理が資源消費の主因のため、そこを律速する）。HTML / CSS は全量バッファ完了まで計上される。
- **上限超過時の応答**: **グローバル**上限超過は `503`（Service Unavailable・サーバー飽和）、**IP 単位**上限超過は `429`（Too Many Requests・当該クライアントの過剰並列）を返す。
- **上限値**: 既定 **グローバル 512 / IP 単位 64**。環境変数 `PROXY_MAX_CONCURRENT` / `PROXY_MAX_CONCURRENT_PER_IP`（いずれもサーバー専用。`NEXT_PUBLIC_` 接頭辞なし）で上書きできる。正の整数以外・未設定は既定値を用いる。1 ページの読み込みは多数のアセットを並列中継するため、IP 単位の既定はブラウザの並列接続数を吸収できる値にしてある。運用インスタンスの処理能力に合わせて調整すること。
- **既知の制約**: インメモリ・単一プロセス前提（[レート制限](#レート制限)と同様）。複数インスタンス構成では各プロセスで独立に計上されるため、全体の上限はインスタンス数倍になる。永続化・分散対応は v2 以降。ストリーム透過本文の転送中は計上しないため、低速大量ダウンロードによる帯域占有自体は本機構では制限しない（帯域制限はリバースプロキシ層の責務）。

### 認証 / 接続元許可制（任意・#148）

> 関連アーキテクチャ: [arch/proxy.md §auth.ts](../../arch/proxy.md#srclibproxyauthts認証--接続元許可制148)。対応 Issue: [#148](https://github.com/f8924919/web-proxy/issues/148)。

本サービスは「開かれていること」を主目的とするオープンプロキシのため、**認証は既定で課さない**（`PROXY_AUTH_TOKEN` 未設定時は従来どおり誰でも利用できる＝後方互換）。一方で社内・限定公開など**制限環境で運用したい場合に限り**、env で**共有シークレットトークン認証**を有効化できる。#133 の乱用緩和（スキーム・ポート制限／同時接続数上限／レート制限）とは独立に働き、これらは認証の有無に依らず常時有効。

- **有効化条件**: 環境変数 `PROXY_AUTH_TOKEN`（サーバー専用。`NEXT_PUBLIC_` 接頭辞なし）に空でない値を設定したときのみ認証を要求する。未設定・空（前後空白のみを含む）は**無効（オープン）**で後方互換。
- **方式**: 単一の共有シークレットトークン。運用者がトークンを利用者へ配布する想定。利用者ごとの識別・個別失効は対象外（必要なら別 Issue）。IP 許可リスト方式は採らない（`getClientIp` は `PROXY_TRUSTED_IP_HEADER` 未設定だと `"unknown"` に縮退し、詐称耐性も信頼ヘッダー設定が前提のため、共有トークンの方が運用前提が少なく堅実）。
- **適用範囲**: **全中継経路**（ページ遷移 `/browse`・`/browse/<...>` とアセット中継 `/api/proxy`・`/api/proxy/<...>`）。プロキシ自身のホーム UI（`/`）と解錠ページ（`/unlock`）はトークン入力の入口のため認証対象外。
- **トークンの受け渡し**: 中継経路の各リクエストで次のいずれかを検証する。**ヘッダーを Cookie より優先**する。
  - **Cookie `__pxy_auth`**（主経路）: ブラウザ閲覧ではページ内リンク・アセット取得にカスタムヘッダーを付けられないため Cookie を用いる。`HttpOnly` / `SameSite=Lax` で発行し、ブラウザが全中継リクエストに自動送出する。これはプロキシ自身の Cookie で、往路はブラウザ受信の `Cookie` を一切上流へ転送せず jar から復元した分だけを載せるため、ターゲットへは**転送されない**（[§サイト間 Cookie アイソレーション](#サイト間-cookie-アイソレーション)）。
  - **ヘッダー `X-Proxy-Token`**（補助）: API / CLI / リバースプロキシ前段からの利用向け。
- **解錠 UX（401 → フォーム POST → Cookie 発行）**: 認証有効時に未認証で**ページ遷移経路**へアクセスすると、トークン入力フォーム付きの **401 ページ**を返す（自動遷移なし。`X-Frame-Options: DENY`）。フォームは `POST {BASE_PATH}/unlock` でトークンを送信し、サーバーが**定数時間比較**で検証する。一致すれば `HttpOnly` Cookie を発行し、元の閲覧 URL（アプリ相対・オープンリダイレクト防止のため検証済み）へ `303` リダイレクトする。不一致なら `401` でフォームを再表示する。トークンを URL・サーバーログ・ブラウザ履歴に残さないため、クエリパラメータ方式は採らない。
- **アセット中継の未認証応答**: アセット（画像・JS 等）への未認証アクセスは HTML フォームではなく `401`（プレーン）を返す。通常はページ自体が先に 401 で止まるため、アセットだけが未認証になるのは Cookie 欠落時に限られる。
- **既知の制約 / 注意**:
  - トークンは Cookie 値・`X-Proxy-Token` に平文で載るため、**TLS 終端必須**（盗聴対策はトランスポート層の責務）。
  - SW / ランタイム横取りシムが `/unlock` を中継経路へ書き換えないよう、`/unlock` は自前ルート（`isProxyOwnPath`）として除外する（[§実行時リクエスト横取りシム](#実行時リクエスト横取りシムsw-非依存124)）。
  - インメモリ状態を持たない（トークンは env 由来の固定値）。複数インスタンス構成でも同一 `PROXY_AUTH_TOKEN` を配れば一貫して機能する。

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
- **CSSOM スタイルの実体化（[#120](https://github.com/f8924919/web-proxy/issues/120)）**: `page.content()` は DOM のテキストノードのみをシリアライズし、CSSOM（`CSSStyleSheet.insertRule()`）で注入された CSS を出力しない。CSS-in-JS（emotion/styled-components 等の本番 "speedy" モード）を使うサイト（例 news.yahoo.co.jp）はクライアントで CSS を CSSOM に直接注入し `<style>` のテキストを空にするため、そのまま取得するとサイト全体の CSS が欠落しレイアウトが崩れる。これを防ぐため、`page.content()` の**直前**に各 `<style>` の `sheet.cssRules` を `<style>` テキストへ書き戻し、`document.adoptedStyleSheets`（構築済みスタイルシート）の内容も `<style>` 要素として `<head>` へ出力してから DOM を取得する。書き戻しはブラウザティアでは常時行う（CSS 欠落は常に不利益のため env フラグは設けない）。cross-origin 等で `cssRules` が読めないシートは安全にスキップし全損させない。既存テキストより CSSOM ルールが多い場合のみ書き戻す（冪等）。
- **描画済み DOM のサイズ上限（[#144](https://github.com/f8924919/web-proxy/issues/144)）**: `page.content()` の**直前**（`inlineCssomStyles` 実体化の後）に、ブラウザ context 内で描画済み DOM の UTF-8 バイト数を概算する。`PROXY_MAX_BUFFER_BYTES`（[§中継本文のサイズ上限](#中継本文のサイズ上限メモリ枯渇-dos-対策134)）を超える場合は `page.content()` を呼ばずに取得を打ち切り、`BodyTooLargeError` 経由で `413` を返す（中継ティアと同じ上限・同じ応答）。`page.content()` で Node ヒープへ全量転送する前にブラウザ側で測ることで、展開後にしか効かない `readTextWithLimit` では防げないメモリ常駐を未然に断つ。概算ベースである点と限界は [§中継本文のサイズ上限](#中継本文のサイズ上限メモリ枯渇-dos-対策134) を参照。
- **待機戦略**: `page.goto` の `waitUntil` / `timeout` と、追加の idle 待ち（settle）を env で調整可能（`debug-browser.mjs` と同じ検証・ベストエフォート方針、[#39](https://github.com/f8924919/web-proxy/issues/39)）。タイムアウト・読み込み失敗でも収集済み DOM をベストエフォートで返す。
- **既定 User-Agent / 認証情報**: 中継ティアと同じ既定 UA（`PROXY_USER_AGENT` で上書き可）をブラウザコンテキストに適用し、受信リクエストの `Cookie` / `Authorization`（現ターゲット origin にスコープされた分）を初回ナビゲーションへ引き継ぐ。

### Cookie セッションウォーミング

ブラウザがナビゲーション中に取得した Cookie（チャレンジ通過後のセッション等）を、**サーバー側 jar へ取り込む**ことで以降の中継へ引き継ぐ。

- ブラウザの cookie jar（`context.cookies()`）を `Set-Cookie` 相当へ変換する（`Domain` は付けない）。
- 変換した `Set-Cookie` は既存の[サイト間 Cookie アイソレーション](#サイト間-cookie-アイソレーション)の経路でサーバー側 jar に取り込まれる（ブラウザへは返さない）。
- 以降、`__pxy_sid` セッション × 現ターゲット origin で jar から復元された Cookie が上流（`/api/proxy` 等）へ転送される。これにより**ブラウザで温めたセッションを軽量な中継ティアへ引き継ぐ**。

### SSRF（不弱化）

ブラウザは任意の JS を実行し任意のサブリクエストを発行するため、中継ティアと**同等のブロックリスト保証**を維持する。

- 初回ナビゲーション URL に[SSRF チェック](#ssrf-対策)を適用する（ブロック時 403）。
- ブラウザの**全サブリクエスト**にも、解決しうる**全アドレス（A / AAAA）**のブロックリスト照合（IPv4 / IPv6 両対応）を適用し、1 つでもブロック対象なら中断する（`context.route` 傍受）。
- **残存制約（TOCTOU）**: Chromium は接続時に自前で再解決するため、中継ティアのような IP ピン留め（[§DNS リバインディング / TOCTOU 対策](#dns-リバインディング--toctou-対策ip-ピン留め)）はできない。`context.route` 段の照合と実接続の間に応答 IP が変わるリバインディングの窓は残るため、内部到達面の遮断は上流 egress プロキシ（`PROXY_BROWSER_PROXY_SERVER`）併用で担保することを推奨する。

### 失敗時のフォールバック

ブラウザの起動失敗・タイムアウト・例外時は、SSRF ブロックを除き**中継ティア（`proxyFetch`）へフォールバック**する（ブラウザ依存で全損にしない）。SSRF ブロックは 403 を返す。

### 既知の制約: クライアント再 hydration（#123）

ブラウザティアは `page.content()`（**JS 実行・hydration 後の DOM**）を配信する。SPA（React/Next.js 等）ではクライアントで同じ框架が再実行され、**既に hydration 済みの DOM に対して再 hydration** を試みて不一致になり、console に React の hydration エラー（`#418`「Hydration failed…」/`#425`「Text content does not match…」等）が多発する（例 `news.yahoo.co.jp` で `#418` ×数十）。

- **影響は実害なし（コンソールノイズ）と切り分け済み（2026-06-23 実測）**。React `#418` は「hydration 失敗 → クライアントで再生成」であり、配信 DOM は既に完全レンダリング済み・同じアプリが同じ埋め込みデータで再描画するため、**視覚的なコンテンツ崩れ・欠落は発生しない**。CSS 欠落（[#120](https://github.com/f8924919/web-proxy/issues/120)）・サブリソース取りこぼし（[#124](https://github.com/f8924919/web-proxy/issues/124)）を解消した後は、ヘッダー・本文・各ランキング等が正しく表示されることを実機確認した。残る一部の動的セクション欠落（例「あなたにおすすめ」）は hydration ではなく**ターゲット側の認可要件**（ログインセッション必須 API の 403）に起因し、本制約とは別。
- **低減策は採らない（意図的な見送り）**。`__NEXT_DATA__` 等の hydration マーカー除去・框架ブートストラップ抑止で再 hydration を止めればエラーは消せるが、**SPA のクライアント操作性・動的更新を壊すリスク**があり、得られるのはノイズ低減のみで割に合わない。配信 DOM の静的スナップショット化（框架スクリプトを配信しない方針）は体験を大きく変える別検討事項とする。
- **付随**: `YAHOO is not defined` / `yadsRenderAd_v2 is not defined` 等は第三者広告スクリプトの読み込み失敗（中断/ブロック）由来で、hydration とは無関係・対処対象外。

### ヒューリスティック自動ティア昇格（崩れ/チャレンジ検出）

> 関連アーキテクチャ: [arch/proxy.md §promotion.ts](../../arch/proxy.md#srclibproxypromotionts)。対応 Issue: [#70](https://github.com/f8924919/web-proxy/issues/70)。

明示 allowlist は手動運用のため、未知サイトの崩れには追従できない。これを補うため、**中継ティア（`proxyFetch`）の初回応答が「崩れている / チャレンジが挟まっている」と判定された場合、自動でブラウザティアへ昇格して再取得**する。allowlist 昇格を**補助**する位置づけで、allowlist が優先（既にブラウザティアの場合は二重取得しない）。

- **有効化**: 専用 env `PROXY_BROWSER_AUTO_PROMOTE`（`true` / `1` / `on` で有効、**既定は無効**）。無効時は明示 allowlist のみが従来どおり動く。本機能はブラウザティア（Playwright）が利用可能な環境での運用を前提とする。
- **対象**: `/browse` **GET の `text/html` 応答のみ**。POST はボディ再送不可のため対象外、`/api/proxy`（アセット中継）・非 HTML 応答・allowlist で既に昇格済みのリクエストも対象外。
- **昇格判定（純粋関数 `shouldPromoteToBrowser(html, status, contentType)`）**: 初回（中継ティア）応答の HTML / ステータス / Content-Type を入力に取り、`text/html` 応答について次の**いずれか**で昇格と判定する。
  - **チャレンジ / bot 判定マーカー**: `enable javascript` / `enablejs` / `checking your browser` / `recaptcha` / Cloudflare チャレンジ等の語句を本文に含む。
  - **`<noscript>` 主体**: `<noscript>` を含み、かつ noscript 外の可視テキストが極小（JS 無効向け案内が本文の主要部）。
  - **bot ブロック相当ステータス**: `403` / `503`。
  - **空 SPA シェル（#160）**: クライアント描画 SPA（例: Dailymotion）は初期 HTML が空シェルで、中継ティアでは `location.pathname` がプロキシパス（`/browse/...`）になり SPA がルーティングできず描画されない。これを拾うため、次の **3 条件をすべて満たす**場合に昇格する（AND）。① 既知の SPA マウント先要素が存在する（`id="root"` / `id="__next"` / `id="app"` / `id="app-root"` のいずれか・タグ種別不問・ID は完全一致で `application` 等の前方一致を弾く）。② 外部スクリプト（`<script src>`）が 1 つ以上ある。③ noscript 外の可視テキストが極小（`<noscript>` 主体と同じ閾値）。マウント先が「空であること」は要求せず（実サイトは空のスケルトン枠を持つため）、未描画の判定は③が担う。
  - 空 body 単独は誤検知が多いため判定材料にしない（上記マーカー / noscript / ステータス / 空 SPA シェルの AND 条件のみを使う）。
- **二重取得コストの抑止（無限ループ防止）**: 同一 URL を短時間ウィンドウ内で一度昇格したら**再昇格しない**。これにより `proxyFetch` → 崩れ検出 → `browserFetch` の二重取得を、URL あたり高々 1 回 / ウィンドウに制限する。
  - **抑止キー**: `ホスト + パス`（**クエリ無視**。[§ナビゲーションループの検出](#ナビゲーションループの検出enablejs-対策)と同方式。`sei` 等の毎回変化するクエリで抑止が外れないようにする）。
  - インメモリ・スライディングウィンドウ（[レート制限](#レート制限)と同方式、プロセス再起動でリセット）。
- **誤検知時の影響最小化（best-effort）**: 昇格後の `browserFetch` が失敗・例外の場合は、初回の中継ティア応答を**そのまま返す**（昇格は best-effort で全損にしない）。SSRF は初回ナビゲーション URL で既に検査済み。

| 項目           | 既定値                                                                                          |
| -------------- | ----------------------------------------------------------------------------------------------- |
| 有効化 env     | `PROXY_BROWSER_AUTO_PROMOTE`（既定 無効）                                                       |
| 対象           | `/browse` GET の `text/html` 応答のみ（POST・非 HTML・allowlist 既昇格は対象外）                |
| 昇格判定       | チャレンジ語句 / `<noscript>` 主体 / `403`・`503` / 空 SPA シェル（#160・3 条件 AND）のいずれか |
| 再昇格抑止キー | ホスト + パス（クエリ無視）                                                                     |
| 抑止ウィンドウ | 60 秒                                                                                           |
| 昇格失敗時     | 初回の中継ティア応答へフォールバック（best-effort）                                             |

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
- **実測（確認済み・2026-06-21）**: クリーン IP（residential。ローカル PC の ISP 回線・上流プロキシなし）+ ブラウザティア（`browserFetch`）で **Google 検索が成功**した（enablejs ループ・`/sorry/` reCAPTCHA に落ちない）。データセンター IP では弾かれていた（[#52]）ことと合わせ、**可否は egress IP の質に支配される**という結論が実証された。本番（データセンター IP）で同等の結果を得るには `PROXY_BROWSER_PROXY_SERVER` の residential プロキシ、または residential IP を持つ外部 CDP サービスが必要（手順は [setup.md §9.4](../../setup.md#94-アンチボット対策egress-ip--stealth73)）。

[#52]: https://github.com/f8924919/web-proxy/issues/52

---

## レスポンスヘッダー処理

以下のヘッダーを除去してからブラウザへ返す。

| 除去対象                  | 理由                                                                                                                                                                                                                                  |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Content-Security-Policy` | プロキシの書き換え済みリソースをブロックする                                                                                                                                                                                          |
| `X-Frame-Options`         | iframe 埋め込み対応の障害になる                                                                                                                                                                                                       |
| `Content-Encoding`        | fetch 後に展開済みのため再設定不要                                                                                                                                                                                                    |
| `Transfer-Encoding`       | 同上                                                                                                                                                                                                                                  |
| `Content-Length`          | 上流の値（多くは圧縮時のサイズ）と、展開・書き換え後にブラウザへ返す実本文長が食い違い、ブラウザが本文を宣言長で切り詰める／`ERR_CONTENT_LENGTH_MISMATCH` を起こすのを防ぐ（#97）。除去してランタイムに再計算（または chunked）させる |
| `Speculation-Rules`       | ブラウザがページ内の `/browse?url=...` リンクを prefetch し、各先読みがフル中継としてレート枠を消費するのを防ぐ（防御的措置）                                                                                                         |

`Content-Type` / `Cache-Control` などはそのまま維持する。

> **`Content-Length` を除去する理由（#97）**: `proxyFetch` は `Accept-Encoding: identity` を送るが、CDN によってはこれを無視して gzip 等で応答する。このとき fetch は本文を展開して渡す一方、上流の `Content-Length` は**圧縮時のサイズ**のまま残る。`Content-Encoding` は除去するため、この値を転送すると実本文長（展開後）と宣言長が食い違い、ブラウザが本文を途中で切り詰める（例: SPA の JS が `Unterminated string in JSON` で初期化失敗）。`text/css` のように本文を作り直す経路ではランタイムが再計算するが、その他の素通し経路では上流値が残るため、`Content-Length` は一律除去してランタイムに再計算させる。

> **前段 CDN（Cloudflare 等）の Speculation/Prefetch について**: `sanitizeHeaders` が除去できるのは**上流（ターゲット）応答**のヘッダーのみ。プロキシ自身の前段に Cloudflare 等がいる場合、`Speculation-Rules`（`/cdn-cgi/speculation` を指す）はアプリ応答の**後段**で注入されるためコードからは除去できない。同一オリジン（プロキシのドメイン）の `/browse?url=...` リンクが prefetch されると中継リクエストが増え、レート制限の枯渇やターゲットへの過剰アクセスを招くため、**当該ドメインでは CDN 側の Speculation Rules / Prefetch URLs 機能を無効化する**こと。

### プロキシ UI レスポンスのクリックジャッキング防止（#131）

上記の除去は**中継レスポンス（ターゲット応答）**が対象で、`X-Frame-Options` をあえて落として iframe 埋め込み中継を成立させる。一方、**プロキシ自身が生成する UI レスポンス**には、逆に `X-Frame-Options: DENY` を**付与**してフレーム埋め込みを禁止する。これがないと、攻撃者ページがプロキシ UI（アドレスバー・案内ページ）を iframe で重ねてクリックジャッキングを成立させられる（[§サイト間アイソレーションの構造的制約](#サイト間アイソレーションの構造的制約131) と同根。OWASP A05 / CWE-1021）。

- **付与対象（プロキシ UI）**: ホーム `/`、`/browse`（`url` 未指定）の案内ページ、中継経路のエラー / ループ案内ページ。これらは `sanitizeHeaders` を通らず、プロキシが直接構築する HTML レスポンス。
- **非付与（中継レスポンス）**: ターゲットの中継本文には付与しない（iframe 埋め込み中継を壊さないため）。中継レスポンスと UI レスポンスは「`sanitizeHeaders` を通すか / プロキシが直接 `Response` を構築するか」で分かれる。
- **実装**: HTML UI レスポンスは共通ヘルパー（`headers.ts`）で `Content-Type` とともに `X-Frame-Options: DENY` を組み立てる。ホーム `/` は React コンポーネントでレスポンスヘッダーを直接付与できないため、`next.config.mjs` の `headers()` で `source: '/'` に限定して付与する（`/browse` / `/api/proxy` には付けない）。

---

## ステータスコードの中継

ターゲットのレスポンスステータスは原則そのままブラウザへ中継する。ただし次の制約を守る。

- **ボディを持てない `204` / `205` / `304`** は、ボディ付きで `Response` を構築すると例外になるため、**ボディを `null` として中継する**（ステータスは維持）。
- **`1xx`（`101` など）** は最終応答として中継できない（`Response` のステータスは `200`〜`599` に限られ、`101` はボディ `null` でも構築が例外になる）。`fetch` が 1xx を最終応答として返すことは実運用ではほぼ無いが、来た場合は下記フォールバックにより **`502`** となる。
- 上記以外でも、**ステータスが `200`〜`599` の範囲外**、または中継・変換（CSS / HTML 書き換え等）の途中で**予期しない例外**が発生した場合は、ハンドラをクラッシュ（500）させず **`502`** を返す。

---

## アセット中継の上流 429 リトライ（Retry-After 尊重・#166）

> 関連アーキテクチャ: [arch/proxy.md §retry.ts](../../arch/proxy.md#srclibproxyretryts上流-429-リトライ166)。対応 Issue: [#166](https://github.com/f8924919/web-proxy/issues/166)。

画像の多いページ（例: Wikipedia のメインページ・記事）では、1 ページ分の数十枚のサムネイルが**単一の egress IP に集中**するため、上流 CDN（例: Wikimedia の Varnish）の IP 単位スロットルに当たり、個々のアセット要求が `429 Too Many Requests`（`Retry-After: 1` 程度の短いソフトスロットル）を返すことがある。ブラウザは画像の `429` を自動再試行しないため、そのままでは画像が欠ける。

これを緩和するため、**アセット中継（`/api/proxy`・`relayAsset`）が上流から `429` を受けた場合に限り、`Retry-After` を尊重してサーバー側で限定回数だけ再試行**する。バースト直後の短い窓を吸収し、大半の画像を復活させる。

- **対象**: **GET / HEAD のアセット中継のみ**。非冪等の `POST` 等は副作用の二重発火を避けるため再試行しない。
- **自前 429 との区別**: [レート制限](#レート制限)・[同時接続数の制限](#同時接続数の制限133)由来の `429` は**上流 fetch の前**にプロキシ自身が発行するため、本リトライの対象外（従来どおり即時 `429`）。再試行するのは **`proxyFetch` が正常返却したレスポンスの `status === 429`**（＝上流由来）に限る。
- **待機時間の決定（`Retry-After` 尊重）**: 応答の `Retry-After` を**秒数・HTTP-date の両形式**でパースして待機ミリ秒を決める。
  - **欠落・解析不能**: 短い既定待機（**1 秒**。上限 `PROXY_ASSET_RETRY_MAX_WAIT_MS` 未満に丸める）で再試行する。
  - **過去日時 / 負値**: 0 とみなして即時再試行する。
  - **上限超過**: `Retry-After` が上限（`PROXY_ASSET_RETRY_MAX_WAIT_MS`、既定 **2000ms**）を超える場合は**再試行せず `429` を即透過**する（サーバー側でリクエストを長時間保持しない）。
- **再試行回数**: 上限（`PROXY_ASSET_RETRY_ATTEMPTS`、既定 **1**）まで。上限到達後は最後の `429` をそのまま透過する。
- **env**: いずれもサーバー専用（`NEXT_PUBLIC_` 接頭辞なし）。正の整数以外・未設定は既定値（`PROXY_ASSET_RETRY_ATTEMPTS`=1 / `PROXY_ASSET_RETRY_MAX_WAIT_MS`=2000）にフォールバックする（既存 `*FromEnv` パターンに準拠）。`PROXY_ASSET_RETRY_ATTEMPTS=0` で本機能を実質無効化できる。
- **同時接続スロットとの関係**: 再試行の待機中も[同時接続数の制限](#同時接続数の制限133)のスロットを保持する（`relayAsset` は上流取得〜レスポンス構築までを 1 スロットとして計上するため）。既定（1 回・最大 2 秒）はこの保持時間を実用上問題ない範囲に抑える設計。回数・上限を大きくする場合は IP 単位同時接続上限への圧迫に留意する。
- **スコープ外**: ページ遷移（`/browse`）の上流 `429` リトライ、`429` 以外のステータス（`503` 等）のリトライ、egress IP 集中そのものの解消（residential プロキシ等は別途）。

---

## SSRF 対策

DNS 解決は **IPv4 / IPv6 の両方**を対象とし、ホスト名が解決しうる**全アドレス（A / AAAA）を検査**する。1 つでもブロック対象に一致すれば遮断する（[#129](https://github.com/f8924919/web-proxy/issues/129) / [#130](https://github.com/f8924919/web-proxy/issues/130)）。

ブロック対象は以下のとおり。

| 分類                          | IPv4                                            | IPv6                                        |
| ----------------------------- | ----------------------------------------------- | ------------------------------------------- |
| ループバック                  | `127.0.0.0/8`                                   | `::1`                                       |
| プライベートネットワーク      | `10.0.0.0/8`、`172.16.0.0/12`、`192.168.0.0/16` | `fc00::/7`（ULA）                           |
| リンクローカル                | `169.254.0.0/16`                                | `fe80::/10`                                 |
| クラウドメタデータ            | `169.254.169.254`（リンクローカルに包含）       | —                                           |
| CGNAT（キャリアグレード NAT） | `100.64.0.0/10`                                 | —                                           |
| 未指定アドレス                | `0.0.0.0/8`（"this network"）                   | `::`                                        |
| IPv4-mapped IPv6              | —                                               | `::ffff:a.b.c.d` は対応する IPv4 として判定 |

ブロック対象の場合は HTTP 403 を返す。**リダイレクト追従時は追従先 URL にも毎ホップ同じチェックを適用する**（[§リダイレクト追従](#リダイレクト追従)）。

### DNS リバインディング / TOCTOU 対策（IP ピン留め）

検査時の名前解決と実接続時の名前解決が**別々に行われる**と、その間に応答 IP を変えて検査をすり抜けられる（DNS リバインディング。[#129](https://github.com/f8924919/web-proxy/issues/129)）。これを防ぐため、`proxyFetch`（中継ティア）は **undici の `Agent`（`connect.lookup` フック）で名前解決を 1 回に統一**し、解決した全アドレスを検査したうえで、**検査に通った IP に固定して接続する（ピン留め）**。これにより「検査した IP」と「接続する IP」が必ず一致し、TOCTOU が成立しない。

> **ブラウザバック中継の残存制約**: ブラウザティア（Chromium）は接続時に**自前で再解決**するため IP ピン留めができず、`installSsrfGuard`（`context.route` 傍受）による解決後 IP の照合までで、リバインディングの窓を完全には閉じられない。クリーン IP / 内部到達面の遮断は上流 egress プロキシ（`PROXY_BROWSER_PROXY_SERVER`）の併用で担保することを推奨する（[§SSRF（不弱化）](#ssrf不弱化)）。

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

### クライアント IP の特定（信頼ヘッダーの明示設定・#132）

レート制限・[ナビゲーションループ検出](#ナビゲーションループの検出enablejs-対策)のバケットキーに使うクライアント IP は、**信頼するヘッダーを環境変数で明示設定したときのみ**そのヘッダー値を採用する。`cf-connecting-ip` / `x-forwarded-for` / `x-real-ip` などは**クライアントが任意に詐称できる**ため、無条件に信頼すると攻撃者がヘッダーをリクエストごとに変えるだけでバケットキーを変え、レート制限・ループ検出・総当たり試行制限を**全て回避**できてしまう（OWASP A04:2021 / CWE-348）。

- **設定**: 環境変数 `PROXY_TRUSTED_IP_HEADER`（サーバー専用。`NEXT_PUBLIC_` 接頭辞なし）に、前段の**信頼できるリバースプロキシ / CDN が必ず上書きするヘッダー名**を 1 つ設定する（例: Cloudflare 配下なら `cf-connecting-ip`、nginx で `proxy_set_header X-Real-IP` するなら `x-real-ip`）。ヘッダー名はケース非依存（内部で小文字化して照合）。
- **採用値**: 設定したヘッダーの値を採用する。`x-forwarded-for` を指定した場合は「`client, proxy1, proxy2, …`」と左→右に積まれ**最左はクライアントが詐称可能**なため、**信頼プロキシが付与する最右の値**を採用する（単一の信頼プロキシ構成での実クライアント IP）。
- **fail-safe 既定**: `PROXY_TRUSTED_IP_HEADER` が未設定、または指定ヘッダーが受信リクエストに無い場合は、転送ヘッダーを一切信頼せず**単一のグローバルバケット**（定数キー `"unknown"`）にフォールバックする。これにより詐称によるバイパスは原理的に塞がれる一方、**未設定のままでは全クライアントがレート制限を共有する**（個別制限を効かせるには明示設定が必須）。接続元 TCP IP は Next.js 15（`next start`・Node ランタイム）のルートハンドラからは取得できないため、既定を「接続元 IP」にはできない。
- **既知の制約**: 複数段プロキシで最外縁が実エッジの構成では、`x-forwarded-for` の最右は直近プロキシの IP になり実クライアントと一致しない場合がある（単一信頼プロキシ前提。多段対応は対象外）。永続化・分散対応は v2 以降。

### store の eviction（メモリ肥大対策・#132）

レート制限・ループ検出の `Map<キー, タイムスタンプ配列>` は、ウィンドウ外のタイムスタンプを除去するだけではキー自体が残り続け、多数の異なるキー（信頼ヘッダー設定時の多数 IP 等）でアクセスされると Map が肥大する。これを防ぐため、`check` 時に**前回 eviction から `windowMs` 以上経過していれば**ストアを走査し、**全タイムスタンプがウィンドウ外になったエントリ（＝空エントリ）を削除**する。走査頻度を `windowMs` ごとに間引くことで、毎リクエストの全走査コストを避ける。これによりメモリ使用量は概ね直近ウィンドウ内にアクセスのあったキー数に比例する範囲に収まる。

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

## エラーログとプライバシー（機微 URL のマスキング・#138）

> 関連アーキテクチャ: [arch/proxy.md §src/lib/logger.ts](../../arch/proxy.md#srclibloggerts共通ロガー138)。対応 Issue: [#138](https://github.com/f8924919/web-proxy/issues/138)。

中継処理の異常系（フォールバック・接続失敗・自動昇格失敗・書き換え失敗・アセット中継失敗）はサーバーログに記録する。閲覧先の URL・ホスト・IP は**機微情報**になり得る（ユーザーがどこを閲覧したかが漏れる。OWASP A09:2021 / CWE-532）ため、ログ出力には次の方針を課す。

- **機微トークンの redact**: ログに混入し得る **URL・ホスト名・IP アドレス**は、出力前にすべて `[redacted-url]` / `[redacted-host]` / `[redacted-ip]` へ置換する。エラー種別（クラス名）は運用診断に必要なため残すが、閲覧先を特定できる値は origin・パスを含め一切残さない。例外オブジェクトのメッセージ・`cause`（ネイティブ fetch 失敗時にホストを含む）・スタックがマスキング対象。
- **レベル制御**: サーバー専用 env `PROXY_LOG_LEVEL`（`NEXT_PUBLIC_` 接頭辞なし）で出力量を制御する。値は `silent` / `error` / `warn` / `info` / `debug`、未設定・未知値は既定 **`error`**。本番では既定で**マスキング済みエラーのみ**を出力し、`silent` で完全抑止、`debug` でスタックトレース付き診断ができる。スタックは `debug` 時のみ出力する。
- **対象**: 現状ログを出すのは中継の異常系 5 箇所（ブラウザフォールバック・接続失敗・自動昇格失敗・HTML 書き換え失敗・アセット中継失敗）。いずれも共通ロガー（[arch/proxy.md §src/lib/logger.ts](../../arch/proxy.md#srclibloggerts共通ロガー138)）経由で出力する。
- **既知の制約**: redact は正規表現ベースで、安全側に倒すため非機微トークンを過剰にマスクし得る（診断性より秘匿を優先）。アクセスログ（リクエストライン）自体の出力は本機能の対象外で、別途リバースプロキシ／ホスティング側の設定に従う。

---

## 関連

- [ホーム画面仕様](../screens/home.md)
- [ブラウズ画面仕様](../screens/browse.md)
