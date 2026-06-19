# プロキシシステム アーキテクチャ

> 関連仕様: [プロキシ機能仕様](../spec/features/proxy.md) / [ブラウズ画面仕様](../spec/screens/browse.md)

[← 目次](index.md)

---

## モジュール構成

```
src/
├── app/
│   ├── browse/
│   │   └── route.ts          # ブラウズ Route Handler
│   └── api/
│       └── proxy/
│           └── route.ts      # アセット中継 Route Handler
├── lib/
│   └── proxy/
│       ├── fetch.ts          # SSRF チェック付き fetch
│       ├── rewrite.ts        # HTML / CSS URL 書き換え（SW 登録・GET フォーム横取り・document.domain シム <script> 注入含む）
│       ├── headers.ts        # レスポンスヘッダー処理
│       ├── clientIp.ts       # クライアント IP 解決（レート制限のキー）
│       ├── rateLimit.ts      # インメモリ レート制限（ページ/アセット別バケット）
│       └── response.ts       # nullBodyStatus 判定ユーティリティ
└── ...

public/
└── sw.js                     # 実行時リクエスト横取り Service Worker
```

---

## Route Handler: `src/app/browse/route.ts`

**役割**: ブラウズ画面の生 HTML レスポンスを返す。React を介さない。`GET`（ページ閲覧）と `POST`（フォーム送信の中継、[機能仕様 §POST 中継](../spec/features/proxy.md#post-中継)）をエクスポートする。

### 処理フロー（GET）

```
1. searchParams.get('url') を取得
2. url が null / パース失敗 → 307 リダイレクト to /
3. pageRateLimiter.check(getClientIp(headers)) → 超過なら 429
4. proxyFetch(url, { headers: forwardableRequestHeaders(req.headers) })
   → SSRF ブロックなら 403 / 到達不能なら 502
   - 受信リクエストの Cookie / Authorization を転送（[機能仕様 §認証情報の転送](../spec/features/proxy.md#認証情報の転送cookie--authorization)）
5. rewriteHtml(html, baseUrl) でアドレスバー HTML を先頭に注入 + URL 書き換え
6. headers.sanitize(responseHeaders) でヘッダーを除去
7. new Response(rewrittenHtml, { headers }) を返す
   （非 HTML はそのまま中継。204/205/304 はボディ null、1xx・範囲外・変換中の例外は 502。
    [機能仕様 §ステータスコードの中継](../spec/features/proxy.md#ステータスコードの中継) 参照）
```

### 処理フロー（POST）

GET との差分のみ記載（共通部はレスポンス処理ヘルパーに集約）。

```
1. searchParams.get('url') を取得
2. url が null / パース失敗 → 400（GET のホームリダイレクトとは異なる）
3. pageRateLimiter.check(...)（GET と同じバケット）→ 超過なら 429
4. proxyFetch(url, { method: 'POST', body: req.body,
                     headers: { ...forwardableRequestHeaders(req.headers), 'content-type': … } })
   - Cookie / Authorization に加え、リクエストの Content-Type を転送（urlencoded / multipart の境界維持）
   - 以降のレスポンス処理（rewriteHtml・sanitize・ステータス中継）は GET と共通
```

> JS 発行の非フォーム POST は SW が `/api/proxy` へ振り向けるため `/browse` POST ハンドラのスコープ外（[機能仕様 §POST 中継](../spec/features/proxy.md#post-中継)）。`redirect: "follow"` によるクロスオリジンへの認証情報漏えいは既知の制約（[機能仕様 §認証情報の転送](../spec/features/proxy.md#認証情報の転送cookie--authorization)）。

### アドレスバー注入

`</body>` タグ直前ではなく、`<body>` タグ直後にインラインスタイルで貼り付ける小さな HTML フラグメントを注入する。外部 CSS 依存なし。

---

## Route Handler: `src/app/api/proxy/route.ts`

**役割**: 静的アセット（CSS・画像・JS）の透過中継に加え、SW が振り向けた非 GET リクエストの中継と CORS プリフライト応答を担う。`GET` / `POST` / `PUT` / `PATCH` / `DELETE` / `OPTIONS` をエクスポートし、`GET`〜`DELETE` は共通の中継ヘルパーへ委譲する（[機能仕様 §CORS プリフライト対応](../spec/features/proxy.md#cors-プリフライト対応)）。

### 処理フロー（GET〜DELETE 共通）

```
1. searchParams.get('url') を取得
2. url が null → 400
3. assetRateLimiter.check(getClientIp(headers)) → 超過なら 429
4. ヘッダー方針をメソッドで分岐:
   - GET/HEAD: forwardableRequestHeaders（許可リスト＝Cookie/Authorization、既存挙動）
   - 非 GET   : relayRequestHeaders（拒否リスト方式で広めに転送）＋ body を転送
   proxyFetch(url, { method, body, headers }) → SSRF ブロックなら 403
5. Content-Type が text/css → rewriteCss(body, baseUrl)
6. headers.sanitize(responseHeaders)
7. 要求に Origin があれば Access-Control-Allow-Origin/-Credentials を付与
8. Response を中継して返す
   （204/205/304 はボディを null として返す。1xx・ステータス範囲外・
    Response 構築・CSS 読取り/変換中の未捕捉例外は 502。
    [機能仕様 §ステータスコードの中継](../spec/features/proxy.md#ステータスコードの中継) 参照）
```

### 処理フロー（OPTIONS / プリフライト）

```
1. buildCorsPreflightHeaders(Origin, Access-Control-Request-Headers) を組み立て
2. 204 No Content で返す（防御的。通常は SW の同一オリジン化でプリフライト自体が発生しない）
```

---

## `src/lib/proxy/fetch.ts`

**役割**: SSRF チェックを行ったうえでターゲットへ fetch する。

### `proxyFetch(url, options?)`

`options` でメソッド・ボディ・追加リクエストヘッダーを受け取り、ターゲットへ転送する（省略時は GET・ボディなし＝従来動作）。

- リクエスト構築（メソッド・ヘッダー結合・ボディ／`duplex` の決定）は純粋関数 **`buildProxyRequestInit(options)`** に分離し、実 `fetch`（I/O）から切り離してテスト可能にする（[テスト方針](../testing/policy.md)：外部 I/O は対象外のため、構築ロジックのみ検証）。
- `User-Agent` / `Accept-Encoding: identity` は既定ヘッダー（`BASE_HEADERS`）として維持し、`options.headers`（例: `Content-Type`・`Cookie`・`Authorization`）を上書き結合する。認証ヘッダーの抽出は呼び出し側（Route Handler）が `forwardableRequestHeaders` で行い、`proxyFetch` 自体は渡されたヘッダーを転送するのみ。
- **既定 `User-Agent`**: 現代ブラウザ相当（Chrome 系）の固定文字列を用いる。`process.env.PROXY_USER_AGENT`（サーバー専用 env。`NEXT_PUBLIC_` なし）が設定されていればそれを、未設定なら固定 Chrome UA を `BASE_HEADERS` の既定値に用いる（`process.env.PROXY_USER_AGENT ?? "<default chrome UA>"`）。独自 UA（旧 `web-proxy/1.0`）はサイトの UA 判定で簡易レイアウト／非対応ページを返されることがあり、表示崩れの原因になるため（[機能仕様 §ターゲットへ送る既定 User-Agent](../spec/features/proxy.md#ターゲットへ送る既定-user-agent)）。
- ボディは `GET` / `HEAD` 以外かつ `body` 指定時のみ設定する。`ReadableStream` をボディに用いるため `duplex: "half"` を付与する（Node 22 / Next.js では `ReadableStream` ボディに必須）。
- **リダイレクト**: `redirect: "follow"`。クロスオリジンへのリダイレクト時に `Authorization` / `Cookie` が漏れ得る既知の制約がある（[機能仕様 §認証情報の転送](../spec/features/proxy.md#認証情報の転送cookie--authorization)）。ハードニングは v2。

### SSRF チェック

1. `URL` でパース（失敗なら例外）
2. `dns.promises.lookup(hostname)` で IP を解決
3. 解決した IP を CIDR ブロックリストと照合（[プロキシ機能仕様 §SSRF 対策](../spec/features/proxy.md) 参照）
4. ブロック対象なら `SsrfBlockedError` を throw
5. `fetch(url, { ...buildProxyRequestInit(options), signal: AbortSignal.timeout(10_000) })` で取得

### エラー型

| エラークラス        | 意味                                  |
| ------------------- | ------------------------------------- |
| `SsrfBlockedError`  | SSRF ブロック（403 を返す）           |
| `FetchTimeoutError` | タイムアウト / 到達不能（502 を返す） |

---

## `src/lib/proxy/rewrite.ts`

**役割**: HTML / CSS の URL を書き換える。

### HTML 書き換え（`node-html-parser` 使用）

相対 URL は `baseUrl` を基準に絶対 URL へ変換してからエンコードする。

| 対象                         | 書き換え先                 |
| ---------------------------- | -------------------------- |
| `<a href>`                   | `/browse?url=<encoded>`    |
| `<form action>`              | `/browse?url=<encoded>`    |
| `<img src>` / `<source src>` | `/api/proxy?url=<encoded>` |
| `<link href>`                | `/api/proxy?url=<encoded>` |
| `<script src>`               | `/api/proxy?url=<encoded>` |

### CSS 書き換え

正規表現で `url(...)` と `@import` を `/api/proxy?url=<encoded>` へ置換。

### アドレスバー注入

`rewriteHtml` は URL 書き換えに加え、アドレスバー HTML スニペットを `<body>` 直後に注入する。

### GET フォーム送信横取りスクリプト注入

> 関連仕様: [プロキシ機能仕様 §GET フォーム送信の横取り](../spec/features/proxy.md#get-フォーム送信の横取り)

`rewriteHtml` は `<body>` 直後（アドレスバー・SW 登録に続けて）に、GET フォーム送信を横取りする `<script>` を注入する。GET フォーム送信ではブラウザが `action` のクエリ文字列（`?url=<target>`）を破棄し、`url` が消失して [ブラウズ Route Handler](#route-handler-srcappbrowseroutets) がホームへリダイレクトしてしまうため、それを補う。

```
document に submit を capture で委任（動的フォームにも効く）:
0. 自前のアドレスバー（#proxy-addressbar 内のフォーム）は独自 onsubmit を持つため除外
1. method が GET 以外 → 何もしない（POST 等は action のクエリが保たれるため素通し）
2. 送信フォームの action から url パラメータを取り出してターゲットとする
   （action に url が無い場合は window.location の url パラメータをフォールバック）
3. preventDefault し、ターゲットのクエリ全体を FormData（フォーム項目）で置き換える
4. action（または window.location）のパス部（BASE_PATH 込みの …/browse）を再利用し、
   <path>?url=<encodeURIComponent(ターゲット)> へ window.location.href で遷移する
```

`BASE_PATH` は `action`/`window.location` のパス部をそのまま再利用することで保持される（スクリプト内で個別に組み立てない）。

### `document.domain` ドメインガード無効化シム注入

> 関連仕様: [プロキシ機能仕様 §`document.domain` ドメインガードの無効化](../spec/features/proxy.md#documentdomain-ドメインガードの無効化)

`rewriteHtml` は、ターゲットの**ホスト名（`new URL(baseUrl).hostname`）を返すよう `document.domain` を見せかけるシム `<script>`** を、ページ内スクリプトより先に実行されるよう **`<head>` 最先頭**へ注入する（他の注入が `<body>` 直後なのに対し、本シムだけは `<head>` 先頭）。一部サイト（例 Yahoo の `yjsecure.js`）が `document.domain` を正規表現で検査し、自オリジン外と判定するとトップフレームを実サイトへリダイレクトするため、プロキシ配下（`document.domain` がプロキシのホスト名）でガードが誤発火するのを防ぐ。

- **実装方式**: `Object.defineProperty(Document.prototype, 'domain', { get: () => <hostname>, set: () => {} })` で getter を上書きする（代入方式は `Origin-Agent-Cluster` 等で禁止され得るため不採用）。`try/catch` で例外を吸収する。
- **注入位置と最先頭性**: `yjsecure.js` は `templa.min.js` が `<head>` 段階で動的挿入し得るため、`<body>` 直後注入では間に合わない。`<head[^>]*>` 直後へ正規表現置換で注入する。`<head>` が無い HTML は `<html>` 直後、それも無ければ文書先頭へフォールバックする。
- **スコープ外**: `location.hostname` / `location.href` など `location` 全体を偽装する汎用シムは対象外（`document.domain` ベースのガード無効化に範囲を限定）。

---

## Service Worker: `public/sw.js`

> 関連仕様: [プロキシ機能仕様 §Service Worker による実行時リクエスト横取り](../spec/features/proxy.md#service-worker-による実行時リクエスト横取り)

**役割**: 閲覧ページ内で JS が実行時に発行するリクエスト（**ナビゲーションを除く全メソッド**）を横取りし、`/api/proxy` 経由へ振り向ける。サーバー側 `rewriteHtml` が捕捉できない動的ロード（画像・スクリプト・XHR・非 GET API 呼び出し）を補完し、同一オリジン化により CORS プリフライトを消す（[機能仕様 §CORS プリフライト対応](../spec/features/proxy.md#cors-プリフライト対応)）。

### 登録

`rewriteHtml` が閲覧ページの `<body>` 直後（アドレスバーに続けて）に登録用 `<script>` を注入する。登録 URL は `${BASE_PATH}/sw.js`、スコープは `${BASE_PATH}/`。

- SW スクリプトは `self.registration.scope` から自身の `BASE_PATH` を導出する（リバースプロキシのパスプレフィックス対応。`next.config.ts` は `basePath` 未使用のため、ブラウザから見えるスコープ＝プレフィックス込みのパスになる）。

### `fetch` ハンドラの処理

```
1. request.mode === "navigate" → 素通し（ページ遷移・フォーム送信に委ねる）
2. 同一オリジンの自前ルート（/browse・/api/proxy・/_next/* 等）→ 素通し
3. clientId から要求元ページ URL（/browse?url=<target>）を取得し、url パラメータをターゲットとする
4. rewriteRequestUrl(requestUrl, pageUrl, swOrigin, basePath) で振り向け先を決定
   - クロスオリジンの絶対 URL → /api/proxy?url=<absolute>
   - 同一オリジンのルート絶対パス（自前ルート以外）→ ターゲット origin に解決し /api/proxy?url=<resolved>
   - 自前ルート → 素通し（null）
5. 振り向け先があれば fetch で応答（非 GET はメソッド・ボディ・リクエストヘッダーを保持、
   credentials: "same-origin"）。なければ素通し。振り向け fetch が失敗しても未処理 reject に
   せず Response.error() を返す
```

> メソッド非依存の URL 書き換えは純粋関数 `rewriteRequestUrl` が担い（メソッドで分岐しない）、非 GET のボディ・ヘッダー保持は `fetch` ハンドラ（ランタイム配線）側で行う。

### 純粋ロジックの分離とテスト

横取り判定・URL 解決・`/api/proxy` への書き換えは純粋関数として `public/sw.js` 内に定義し、`module.exports`（CommonJS）で公開する。SW ランタイム配線（`addEventListener('fetch', ...)`）は `importScripts` の有無で**ガード**し、Node（テスト）環境では実行されないようにする。これにより、配信される SW 本体の純粋ロジックを Node 環境のテストで直接検証でき、ロジックの重複を避ける（[テスト方針](../testing/policy.md) / `tests/lib/proxy/sw-intercept.test.ts`）。

### 制約（MVP）

- **ナビゲーションは対象外**。ページ遷移・フォーム送信はサーバー側書き換えに委ねる。
- **`credentials: "same-origin"` で振り向け**。振り向け先は常に同一オリジンの `/api/proxy` であり、プロキシ自身が認証プロキシ（Cloudflare Access 等）の背後にある場合でもプロキシ origin の認証 cookie を届かせられる。プロキシ自身のインフラ認証 cookie は上流転送の手前で除去する（`stripInfraCookies`）。任意ターゲットへの完全な credentials 制御は v2 課題（[機能仕様 §CORS プリフライト対応](../spec/features/proxy.md#cors-プリフライト対応)）。
- **パス相対 URL は best-effort**。閲覧ページ URL（`/browse`）基準で解決されるため、ターゲット上のパス文脈を完全には復元できない。ルート絶対・絶対 URL は正しく振り向く。

---

## `src/lib/proxy/headers.ts`

**役割**: ターゲットのレスポンスヘッダーから不要なものを除去する。加えて、リクエスト側で転送する認証ヘッダーの抽出も担う。

除去対象（`Speculation-Rules` を含む）は [プロキシ機能仕様 §レスポンスヘッダー処理](../spec/features/proxy.md) を参照。前段 CDN が後段で注入する `Speculation-Rules` はコードからは除去できないため CDN 側設定で無効化する（同仕様の注記参照）。

`Set-Cookie` の `Domain` 属性を除去する処理（`sanitizeSetCookie`）もここで行う。

### `forwardableRequestHeaders(incoming)`

> 関連仕様: [プロキシ機能仕様 §認証情報の転送](../spec/features/proxy.md#認証情報の転送cookie--authorization)

受信リクエストの `Headers` から、ターゲットへ転送してよい認証ヘッダーを**許可リスト**（`Cookie` / `Authorization`）で抜き出し `Record<string, string>` で返す純粋関数。存在するヘッダーのみを含める。全ヘッダー素通しを避け、転送対象を明示的に限定する。`GET` 中継（`/browse` GET / `/api/proxy` GET）が `proxyFetch` の `options.headers` へ渡す（`/browse` POST は `content-type` も併せて渡す）。転送する `Cookie` からはプロキシ自身のインフラ認証 cookie を `stripInfraCookies` で除去する（下記）。

### `stripInfraCookies(cookieHeader)`

> 関連仕様: [プロキシ機能仕様 §非 GET 中継のリクエストヘッダー転送](../spec/features/proxy.md#非-get-中継のリクエストヘッダー転送)

`Cookie` ヘッダー値から、プロキシ自身が認証プロキシ（Cloudflare Access 等）の背後にあるときに付与される認証 cookie（`CF_Authorization` / `CF_AppSession`、大文字小文字非依存）を除去する純粋関数。SW は同一オリジン化のため `credentials: "same-origin"` で `/api/proxy` へ振り向けるので、これらの cookie が `/api/proxy` に届く。プロキシ自身の認証情報をターゲットへ漏らさないよう、上流転送の手前（`forwardableRequestHeaders` / `relayRequestHeaders`）で除去する。除去後に cookie が残らなければ空文字を返し、呼び出し側は `Cookie` ヘッダーを付けない。

### `relayRequestHeaders(incoming)`

> 関連仕様: [プロキシ機能仕様 §CORS プリフライト対応](../spec/features/proxy.md#cors-プリフライト対応)

SW が `/api/proxy` へ振り向けた**非 GET 中継**向けに、リクエストヘッダーを**拒否リスト方式**で広めに転送する純粋関数。`host` / `connection` / `content-length` / `transfer-encoding` / `keep-alive` / `te` / `upgrade` / `accept-encoding` 等の hop-by-hop・インフラ系を除外し、`Content-Type` / `Authorization` / `Cookie` / `X-*` 等を残す。`X-CSRF-Token` などカスタムヘッダー依存の API を動かすため、許可リスト（`forwardableRequestHeaders`）より広く取る。残す `Cookie` からはプロキシ自身のインフラ認証 cookie を `stripInfraCookies` で除去する。

### `buildCorsPreflightHeaders(origin, requestHeaders)`

> 関連仕様: [プロキシ機能仕様 §CORS プリフライト対応](../spec/features/proxy.md#cors-プリフライト対応)

`OPTIONS` 応答用の CORS 許可ヘッダー（`Access-Control-Allow-Origin/-Methods/-Headers/-Credentials`・`Max-Age`・`Vary`）を組み立てる純粋関数。`origin` をエコーし（無ければ `*`）、`Access-Control-Request-Headers` をエコーする。`origin` がある場合のみ `Allow-Credentials: true` を付ける（`*` と `credentials` は併用不可のため）。

---

## `src/lib/proxy/rateLimit.ts`

**役割**: インメモリ・スライディングウィンドウによるレート制限。

### データ構造

```ts
// Map<ip, タイムスタンプ配列（直近 windowMs 分）>
const store = new Map<string, number[]>();
```

### `RateLimiter`（上限を設定可能）

`RateLimiter` は上限 `maxRequests` とウィンドウ `windowMs` をコンストラクタ引数で受け取る（既定: 60 件 / 60 秒）。ページ遷移とアセット中継で別々の上限・別々のバケット（独立インスタンス）を使うため、用途別に 2 つのインスタンスを公開する。

```ts
export const pageRateLimiter = new RateLimiter(60); // /browse 用
export const assetRateLimiter = new RateLimiter(600); // /api/proxy 用
```

`check(ip: string): void` の挙動:

- 現在時刻から `windowMs` 以内のタイムスタンプのみ残す
- `maxRequests` 件以上なら `RateLimitExceededError` を throw
- 現在時刻を追記

> 上限値の根拠・分離の理由は [機能仕様 §レート制限](../spec/features/proxy.md#レート制限) を参照。

### 制約

- Node.js runtime のインメモリのみ。プロセス再起動でリセットされる。
- 複数 Next.js インスタンスをまたいだ共有は非対応（v2 以降）。

---

## `src/lib/proxy/clientIp.ts`

**役割**: リクエストヘッダーからレート制限のバケットキーに使うクライアント IP を解決する純粋関数 `getClientIp(headers: Headers): string`。

優先順は `cf-connecting-ip` → `x-forwarded-for`（先頭の値）→ `x-real-ip` → `"unknown"`。`/browse` と `/api/proxy` の両 Route Handler から共通利用する（解決ロジックの重複を排除）。詳細は [機能仕様 §クライアント IP の特定](../spec/features/proxy.md#クライアント-ip-の特定)。

---

## リバースプロキシ下でのパスプレフィックス

code-server のポート転送（`/proxy/3000/`）など、リバースプロキシがパスプレフィックスを付与する環境向けの設定。

### 環境変数

```bash
# .env.local
NEXT_PUBLIC_BASE_PATH=/proxy/3000
```

### `next.config.ts` — `assetPrefix`

```ts
assetPrefix: process.env.NEXT_PUBLIC_BASE_PATH ?? "";
```

`basePath` ではなく `assetPrefix` を使う理由：

- **`basePath`** は `_next/static/...` の**サーブパス**を移動する。code-server はプレフィックスを除去してからポートへ転送するため `/_next/...` に来てしまい 404 になる。
- **`assetPrefix`** は HTML 内に出力される `<script src="...">` の参照先のみ変更し、実際のサーブパスは `/_next/...` のまま維持する。プレフィックス除去後の転送と整合する。

### `src/lib/proxy/rewrite.ts` — URL 書き換えへの影響

```ts
const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
// /browse → ${BASE_PATH}/browse
// /api/proxy → ${BASE_PATH}/api/proxy
```

`rewrite.ts` は HTML 書き換え時に `/browse` と `/api/proxy` の先頭に `BASE_PATH` を付ける。これにより、リバースプロキシ下でもリンクが正しいパスを指す。

アドレスバー HTML のフォーム `action` とホームリンクも同様に `BASE_PATH` を付与する。
