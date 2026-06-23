# プロキシシステム アーキテクチャ

> 関連仕様: [プロキシ機能仕様](../spec/features/proxy.md) / [ブラウズ画面仕様](../spec/screens/browse.md)

[← 目次](index.md)

---

## モジュール構成

```
src/
├── app/
│   ├── browse/
│   │   ├── route.ts          # ブラウズ Route Handler（後方互換 ?url=・GET は 307 でパス反映へ・POST 中継）
│   │   └── [...slug]/
│   │       └── route.ts      # ブラウズ Route Handler（パス反映形式 /browse/<scheme>/<host>/<path>・正本。#115）
│   └── api/
│       └── proxy/
│           ├── route.ts            # アセット中継 Route Handler（旧 ?url= 形式・後方互換）
│           └── [...slug]/
│               └── route.ts        # アセット中継 Route Handler（パス反映形式 /api/proxy/<scheme>/<host>/<path>。#100）
├── lib/
│   └── proxy/
│       ├── fetch.ts          # SSRF チェック付き fetch
│       ├── browserFetch.ts   # ヘッドレスブラウザ中継（ブラウザバック中継・ティア判定・Cookie ウォーミング）
│       ├── rewrite.ts        # HTML / CSS URL 書き換え（SW 登録・GET フォーム横取り・クリックナビ横取り・document.domain シム・実行時リクエスト横取りシム <script> 注入含む）
│       ├── proxyPath.ts      # アセット中継 URL スキーム（パス反映）の組み立て・復元（純粋関数。#100）
│       ├── browsePath.ts     # ブラウズ URL スキーム（パス反映）の組み立て・復元（純粋関数。#115）
│       ├── relayAsset.ts     # アセット中継の共通処理（両 route が共有。中継・CORS・OPTIONS）
│       ├── browseRelay.ts    # ブラウズ中継の共通処理（両 route が共有。ティア選択・ループ検出・HTML 書き換え）
│       ├── headers.ts        # レスポンスヘッダー処理
│       ├── clientIp.ts       # クライアント IP 解決（レート制限のキー）
│       ├── rateLimit.ts      # インメモリ レート制限（ページ/アセット別バケット）
│       ├── loopGuard.ts      # ナビゲーションループ検出（enablejs 自己再ナビ対策）
│       ├── promotion.ts      # ヒューリスティック自動ティア昇格（崩れ/チャレンジ検出・再昇格抑止）
│       └── response.ts       # nullBodyStatus 判定・相対リダイレクト生成ユーティリティ
└── ...

public/
└── sw.js                     # 実行時リクエスト横取り Service Worker
```

---

## Route Handler: `src/app/browse/route.ts` ＋ `src/app/browse/[...slug]/route.ts`

**役割**: ブラウズ画面の生 HTML レスポンスを返す。React を介さない。パス反映形式 `/browse/<scheme>/<host>/<path>`（`[...slug]/route.ts`・正本。#115）が中継の本体で、後方互換 `/browse?url=`（`route.ts`）は GET をパス反映 URL へ 307 リダイレクトし、POST のみ直接中継する。中継・レスポンス処理・ループ検出は共通処理 `src/lib/proxy/browseRelay.ts`（`relayBrowse` / `browseGuards`）へ委譲し、両 route が共有する。

### パス反映ルート `[...slug]/route.ts`（正本・#115）

`browsePath.ts` の純粋関数 `targetFromBrowsePath(pathname, search)` で `/browse/<scheme>/<host>/<path>` からターゲット絶対 URL を復元する（percent-encoding を保つため `req.nextUrl.pathname`（生）から復元）。復元不能なら 400。以降は下記 GET / POST フローの 3 以降と同じ。閲覧ページの `location` がターゲットを反映するため、ターゲット SPA が `location` を読んで再構築するリンクが proxy 専用パラメータで汚染されない（[機能仕様 §ページ遷移のパス反映](../spec/features/proxy.md#ページ遷移のパス反映115)）。

> 末尾スラッシュ（ターゲット root `path="/"`）の URL `…/browse/https/host/` を Next 既定の trailing-slash 正規化が 308 で剥がすと、その Location が BASE_PATH を失いリバースプロキシ配下で 404 になる（#74 と同類）。`next.config.mjs` の `skipTrailingSlashRedirect: true` で無効化し、catch-all ルートが末尾スラッシュ有無を直接処理する。

### 後方互換ルート `route.ts`（?url=）

- **GET**: `searchParams.get('url')` を取得。null は案内ページ(200)、パース失敗・非 http(s) は 400。url があれば `buildBrowsePath(url, BASE_PATH)` で組み立てたパス反映 URL へ **307 リダイレクト**する（上流取得・レート制限・ループ検出はリダイレクト先で行い二重計上しない）。外部リンク・ブックマーク・アドレスバー入力経由でも最終的に `location` をクリーンにする。
- **POST**: パス反映へのリダイレクトは行わず、従来どおり `?url=` を直接中継する（下記 POST フロー）。

### 処理フロー（GET・パス反映ルート / 旧ルートのリダイレクト先）

```
1. （[...slug]）targetFromBrowsePath(nextUrl.pathname, nextUrl.search) でターゲット復元 → 復元不能なら 400
2. （旧ルート GET）url が null → 案内ページ(200)。あればパス反映 URL へ 307 リダイレクト
3. pageRateLimiter.check(getClientIp(headers)) → 超過なら 429
3b. navigationLoopGuard.check(ip, url) → ループ検出なら静的案内ページ(200) を返して打ち切り
   （host+path 単位の短時間連続遷移を検出。[機能仕様 §ナビゲーションループの検出](../spec/features/proxy.md#ナビゲーションループの検出enablejs-対策)）
4. ティア判定 shouldUseBrowser(url, browserTierConfigFromEnv()) で中継先を選ぶ
   - 既定（中継ティア）: { response, finalUrl } = proxyFetch(url, { headers: forwardableRequestHeaders(req.headers) })
   - ブラウザティア（allowlist 一致）: browserFetch(url, …)。失敗（SSRF 以外）は proxyFetch へフォールバック
     （[機能仕様 §ブラウザバック中継](../spec/features/proxy.md#ブラウザバック中継browser-backed-fetch)）
   → SSRF ブロックなら 403 / 到達不能なら 502
   - 受信リクエストの Cookie / Authorization を転送（[機能仕様 §認証情報の転送](../spec/features/proxy.md#認証情報の転送cookie--authorization)）
   - POST・/api/proxy は対象外で常に中継ティア
4b. 自動ティア昇格（GET の text/html・allowlist 未昇格のみ）: autoPromoteEnabledFromEnv() が有効で
   shouldPromoteToBrowser(html, status, contentType) が崩れ/チャレンジを検出し、かつ promotionGuard が
   同一 host+path を再昇格抑止しない場合、browserFetch で再取得して結果を差し替える
   （失敗時は初回の中継応答へフォールバック。[機能仕様 §ヒューリスティック自動ティア昇格](../spec/features/proxy.md#ヒューリスティック自動ティア昇格崩れチャレンジ検出)）
5. text/html は readTextWithLimit(res, maxBufferBytesFromEnv()) で上限内に読み
   （超過は BodyTooLargeError → 413。#134）、rewriteHtml(html, finalUrl) でアドレスバー HTML を
   先頭に注入 + URL 書き換え（baseUrl はリダイレクト追従後の最終 URL。#42。
   [機能仕様 §リダイレクト追従](../spec/features/proxy.md#リダイレクト追従)）。
   非 HTML は res.body をストリーム透過（上限対象外）
6. headers.sanitize(responseHeaders) でヘッダーを除去
7. new Response(rewrittenHtml, { headers }) を返す
   （非 HTML はそのまま中継。204/205/304 はボディ null、HTML 本文が上限超過なら 413、
    1xx・範囲外・変換中の例外は 502。
    [機能仕様 §ステータスコードの中継](../spec/features/proxy.md#ステータスコードの中継) 参照）
```

### 処理フロー（POST）

GET との差分のみ記載（共通部はレスポンス処理ヘルパーに集約）。

```
1. searchParams.get('url') を取得
2. url が null / パース失敗 → 400（GET の案内ページとは異なり 400）
3. pageRateLimiter.check(...)（GET と同じバケット）→ 超過なら 429
4. proxyFetch(url, { method: 'POST', body: req.body,
                     headers: { ...forwardableRequestHeaders(req.headers), 'content-type': … } })
   - Cookie / Authorization に加え、リクエストの Content-Type を転送（urlencoded / multipart の境界維持）
   - 以降のレスポンス処理（rewriteHtml・sanitize・ステータス中継）は GET と共通
```

> JS 発行の非フォーム POST は SW が `/api/proxy` へ振り向けるため `/browse` POST ハンドラのスコープ外（[機能仕様 §POST 中継](../spec/features/proxy.md#post-中継)）。リダイレクト追従時のクロスオリジン認証情報漏えいは `redirect: "manual"` の自前追従でハードニング済み（#26。[機能仕様 §リダイレクト追従](../spec/features/proxy.md#リダイレクト追従)）。

### アドレスバー注入

`</body>` タグ直前ではなく、`<body>` タグ直後にインラインスタイルで貼り付ける小さな HTML フラグメントを注入する。外部 CSS 依存なし。

バーは `position: fixed; top:0`（ビューポート基準で常に上部固定）。`position: sticky` はターゲットが `html, body { height:100% }` を指定すると包含ブロックが 1 ビューポート分に制限され、スクロールでバーが画面外へ消えるため採用しない（#108。ipleak.net 等で発生）。`fixed` でコンテンツに重ならないよう、バー直後にスペーサー `#proxy-addressbar-spacer` を挿入し、その高さをバーの実レンダリング高へ同期する（初期 + `resize` / `load`）。

---

## Route Handler: `src/app/api/proxy/route.ts` ＋ `src/app/api/proxy/[...slug]/route.ts`

**役割**: 静的アセット（CSS・画像・JS）の透過中継に加え、SW が振り向けた非 GET リクエストの中継と CORS プリフライト応答を担う。両 route とも `GET` / `POST` / `PUT` / `PATCH` / `DELETE` / `OPTIONS` をエクスポートし、共通処理 `src/lib/proxy/relayAsset.ts` の `relayAsset(req, targetHref)` / `proxyOptions(req)` へ委譲する。

- **`[...slug]/route.ts`（パス反映形式・正本。#100）**: `relayAsset.ts` の純粋関数 `targetFromProxyPath(pathname, search)` で `/api/proxy/<scheme>/<host>/<path>` からターゲット絶対 URL を復元する（パス由来の percent-encoding を保つため `req.nextUrl.pathname`（生）から復元し、`req.nextUrl.search` をターゲットのクエリとして付す）。復元不能なら 400。スキーム詳細は [機能仕様 §プロキシ URL スキーム](../spec/features/proxy.md#プロキシ-url-スキームパス反映)。
- **`route.ts`（旧 `?url=` 形式・後方互換）**: `searchParams.get('url')` でターゲットを得る。デプロイ跨ぎで残る既存ページ／旧 SW のリクエスト救済用。

### 処理フロー（`relayAsset(req, targetHref)`。GET〜DELETE 共通）

```
1. targetHref を URL として解析（不正なら 400）
2. （路 route 側で targetHref を決定: パス反映復元 or ?url=）
3. assetRateLimiter.check(getClientIp(headers)) → 超過なら 429
4. ヘッダー方針をメソッドで分岐:
   - GET/HEAD: forwardableRequestHeaders（許可リスト＝Cookie/Authorization、既存挙動）
   - 非 GET   : relayRequestHeaders（拒否リスト方式で広めに転送）＋ body を転送
   { response, finalUrl } = proxyFetch(url, { method, body, headers }) → SSRF ブロックなら 403
5. Content-Type が text/css → readTextWithLimit(res, maxBufferBytesFromEnv()) で
   上限内に読み（超過は BodyTooLargeError → 413）、rewriteCss(css, finalUrl)
   （baseUrl は追従後の最終 URL。#42。サイズ上限は #134）。
   text/css 以外は res.body をストリーム透過（上限対象外）
6. headers.sanitize(responseHeaders)
7. allowedCorsOrigin(Origin, Host) が非 null（＝同一オリジン）の場合のみ
   Access-Control-Allow-Origin/-Credentials を付与（第三者クロスオリジンには付けない。#27）
8. Response を中継して返す
   （204/205/304 はボディを null として返す。CSS 本文が上限超過なら 413。
    1xx・ステータス範囲外・Response 構築・CSS 読取り/変換中の未捕捉例外は 502。
    [機能仕様 §ステータスコードの中継](../spec/features/proxy.md#ステータスコードの中継) 参照）
```

### 処理フロー（OPTIONS / プリフライト）

```
1. allowedCorsOrigin(Origin, Host) で同一オリジン照合し許可 Origin（または null）を得る
2. buildCorsPreflightHeaders(許可Origin, Access-Control-Request-Headers) を組み立て
3. 204 No Content で返す（防御的。通常は SW の同一オリジン化でプリフライト自体が発生しない）
```

---

## `src/lib/proxy/fetch.ts`

**役割**: SSRF チェックを行ったうえでターゲットへ fetch する。

### `proxyFetch(url, options?)`

`options` でメソッド・ボディ・追加リクエストヘッダーを受け取り、ターゲットへ転送する（省略時は GET・ボディなし＝従来動作）。

- リクエスト構築（メソッド・ヘッダー結合・ボディ／`duplex` の決定）は純粋関数 **`buildProxyRequestInit(options)`** に分離し、実 `fetch`（I/O）から切り離してテスト可能にする（[テスト方針](../testing/policy.md)：外部 I/O は対象外のため、構築ロジックのみ検証）。
- `User-Agent` / `Accept-Encoding: identity` は既定ヘッダー（`BASE_HEADERS`）として維持し、`options.headers`（例: `Content-Type`・`Cookie`・`Authorization`）を上書き結合する。**結合はヘッダー名の大文字小文字を区別しない**（HTTP ヘッダー名はケース非依存＝ RFC 7230 §3.2）。非 GET 中継の `relayRequestHeaders` は受信ヘッダーを小文字キーで返すため、既定の `User-Agent`（大文字）と呼び出し側の `user-agent`（小文字）が**別キーとして二重化しないよう**、ケースを正規化して同名は呼び出し側を後勝ちにする（#43）。認証ヘッダーの抽出は呼び出し側（Route Handler）が `forwardableRequestHeaders` で行い、`proxyFetch` 自体は渡されたヘッダーを転送するのみ。
- **既定 `User-Agent`**: 現代ブラウザ相当（Chrome 系）の固定文字列を用いる。`process.env.PROXY_USER_AGENT`（サーバー専用 env。`NEXT_PUBLIC_` なし）が設定されていればそれを、未設定なら固定 Chrome UA を `BASE_HEADERS` の既定値に用いる（`process.env.PROXY_USER_AGENT ?? "<default chrome UA>"`）。独自 UA（旧 `web-proxy/1.0`）はサイトの UA 判定で簡易レイアウト／非対応ページを返されることがあり、表示崩れの原因になるため（[機能仕様 §ターゲットへ送る既定 User-Agent](../spec/features/proxy.md#ターゲットへ送る既定-user-agent)）。
- ボディは `GET` / `HEAD` 以外かつ `body` 指定時のみ設定する。`ReadableStream` をボディに用いるため `duplex: "half"` を付与する（Node 22 / Next.js では `ReadableStream` ボディに必須）。
- **リダイレクト**: `redirect: "manual"` で自前追従する（#26）。詳細は下記「リダイレクト追従」。
- **戻り値**: `proxyFetch` は `{ response, finalUrl }` を返す。`finalUrl` はリダイレクト追従後の最終 URL で、呼び出し側は `rewriteHtml` / `rewriteCss` の `baseUrl` にこれを用いる（#42。[機能仕様 §リダイレクト追従](../spec/features/proxy.md#リダイレクト追従)）。

### リダイレクト追従（`redirect: "manual"` の自前ループ）

`fetch` を `redirect: "manual"` で呼び、`3xx` + `Location` の間ループして追従する（最大 5 ホップ。超過は `TooManyRedirectsError`）。各ホップで以下を行う（検証ロジックは純粋関数に分離してテスト可能にする。[テスト方針](../testing/policy.md)）。

| 純粋関数                                             | 役割                                                                |
| ---------------------------------------------------- | ------------------------------------------------------------------- |
| `isRedirectStatus(status)`                           | `301/302/303/307/308` 判定                                          |
| `resolveRedirectTarget(loc, base)`                   | `Location` を現在 URL 基準で絶対 URL 化（不正なら `null`）          |
| `sameOrigin(a, b)`                                   | 2 URL の origin 一致判定                                            |
| `stripCredentialHeaders(h)`                          | `Authorization` / `Cookie` をケース非依存で除去（別オリジン追従時） |
| `nextRedirectMethod(status, method, replayableBody)` | 追従時のメソッド／ボディ送出可否を決定                              |

- **認証情報の保護**: 追従先が**元リクエストと別オリジン**なら `stripCredentialHeaders` で `Authorization` / `Cookie` を落としてから次へ。
- **SSRF 再チェック**: 毎ホップ `assertSsrfAllowed(url)`（後述 SSRF チェックを関数化したもの）を適用。追従先が内部 IP 等でも `SsrfBlockedError`（403）。
- **メソッド / ボディ**: `301/302/303` は `GET`・ボディなしへ降格。`307/308` はメソッド保持だが、`ReadableStream` ボディ（再送不可）は安全側で `GET`・ボディなしに降格。
- **タイムアウト**: 全ホップで 1 つの `AbortSignal.timeout(10_000)` を共有（合計 10 秒）。

### SSRF チェック（`assertSsrfAllowed(url)` / `isSsrfBlocked(ip)`）

初回・追従先の双方から呼ぶ非同期ヘルパーに集約する。

1. `URL` でパース（失敗なら例外）
2. `dns.promises.lookup(hostname, { all: true, verbatim: true })` で**全アドレス（A / AAAA）**を解決
3. 解決した**各 IP** を `isSsrfBlocked` でブロックリスト照合する（[プロキシ機能仕様 §SSRF 対策](../spec/features/proxy.md#ssrf-対策) 参照）。1 つでも一致すれば `SsrfBlockedError` を throw

`isSsrfBlocked(ip)` は `net.isIP` で IPv4 / IPv6 を判定し、それぞれのブロックリスト（IPv4: ループバック / RFC1918 / リンクローカル / CGNAT `100.64.0.0/10` / 未指定。IPv6: `::1` / `fc00::/7` / `fe80::/10` / `::`。IPv4-mapped `::ffff:a.b.c.d` は対応 IPv4 として判定）と照合する純粋関数（[#129](https://github.com/f8924919/web-proxy/issues/129) / [#130](https://github.com/f8924919/web-proxy/issues/130)）。

#### DNS リバインディング / TOCTOU 対策（IP ピン留め・undici `Agent`）

> 関連仕様: [プロキシ機能仕様 §DNS リバインディング / TOCTOU 対策（IP ピン留め）](../spec/features/proxy.md#dns-リバインディング--toctou-対策ip-ピン留め)

`assertSsrfAllowed` の事前検査だけでは、`fetch` が接続時に独立して再解決するため、検査と接続の間に応答 IP を変えるリバインディングを防げない（[#129](https://github.com/f8924919/web-proxy/issues/129)）。`proxyFetch` は **undici の `Agent` を `dispatcher` として渡し、`connect.lookup` フックで名前解決を 1 回に統一**する。フック内で全アドレスを `isSsrfBlocked` 照合し、通過した IP を `callback` でそのまま返して接続に固定する（ピン留め）。`connect.lookup` のロジック中心部（アドレス配列 → 採用 IP / 遮断判定）は純粋関数に切り出してテスト対象にする（[テスト方針](../testing/policy.md)）。

> **ブラウザバック中継の残存制約**: Chromium は接続時に自前再解決するため同様のピン留めができない。`installSsrfGuard` の `context.route` 照合までで、リバインディングの窓は残る（[機能仕様 §SSRF（不弱化）](../spec/features/proxy.md#ssrf不弱化)）。

### エラー型

| エラークラス            | 意味                                     |
| ----------------------- | ---------------------------------------- |
| `SsrfBlockedError`      | SSRF ブロック（403 を返す）              |
| `FetchTimeoutError`     | タイムアウト / 到達不能（502 を返す）    |
| `TooManyRedirectsError` | リダイレクト追従が上限超過（502 を返す） |
| `BodyTooLargeError`     | 中継本文が上限超過（413 を返す。#134）   |

### 中継本文のサイズ上限（`readTextWithLimit` / `maxBufferBytesFromEnv`・#134）

> 関連仕様: [プロキシ機能仕様 §中継本文のサイズ上限](../spec/features/proxy.md#中継本文のサイズ上限メモリ枯渇-dos-対策134)

書き換えのため全量バッファする HTML / CSS の本文に上限を設ける純粋関数群。

- `maxBufferBytesFromEnv(env = process.env)`: `PROXY_MAX_BUFFER_BYTES` を整数として読み、正の整数以外・未設定なら既定 `10 * 1024 * 1024`（10 MiB）を返す（`*FromEnv` パターン）。
- `readTextWithLimit(res, maxBytes)`: `res.text()` の代替。①`Content-Length` が `maxBytes` 超過を宣言していれば読む前に `BodyTooLargeError` を投げる。②`res.body`（Web Streams `ReadableStream<Uint8Array>`）を `getReader()` でチャンク読みし、累積バイト数が `maxBytes` を超えたらストリームを `cancel` して `BodyTooLargeError` を投げる。上限内なら UTF-8 デコードした文字列を返す（`res.body` が無ければ空文字）。

`relayBrowse`（HTML）・`relayAsset`（CSS）はこれを用いて読み、`BodyTooLargeError` を捕捉して `413` を返す。書き換え不要アセットは `res.body` ストリーム透過のため対象外。

---

## `src/lib/proxy/browserFetch.ts`

> 関連仕様: [プロキシ機能仕様 §ブラウザバック中継](../spec/features/proxy.md#ブラウザバック中継browser-backed-fetch)

**役割**: 特定サイトの `/browse` GET について、初回ナビゲーションをヘッドレスブラウザ（インプロセス Playwright）で実行し、JS 解決後の DOM を `proxyFetch` と同じ `{ response, finalUrl }` 契約で返す。あわせてブラウザが取得した Cookie をスコープ化のため `Set-Cookie` 化して返す（セッションウォーミング）。

### ティア判定（純粋関数）

| 純粋関数                        | 役割                                                                                                                                                 |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `parseBrowserHosts(raw)`        | `PROXY_BROWSER_HOSTS`（カンマ区切り）を正規化したホスト接尾辞配列にする                                                                              |
| `browserTierConfigFromEnv(env)` | `PROXY_BROWSER_MODE` / `PROXY_BROWSER_HOSTS` から `{ mode, hosts }` を組み立てる。MODE 未設定・不正値時は HOSTS が非空なら `allowlist`、空なら `off` |
| `shouldUseBrowser(url, config)` | URL とコンフィグからブラウザティアを使うか判定。`off`→常に false、`on`→常に true、`allowlist`→ホスト接尾辞一致時のみ true。URL 不正は false          |

- ホスト一致は接尾辞方式: `example.com` は `example.com` と `*.example.com` に一致する（`host === suffix || host.endsWith("." + suffix)`）。
- env 未設定時は `off` 相当で**常に中継ティア**（既定挙動の回帰なし）。

### 待機・Cookie 変換（純粋関数）

| 純粋関数                        | 役割                                                                                                                                                                                                          |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `resolveBrowserWaitConfig(env)` | `PROXY_BROWSER_WAIT_UNTIL` / `PROXY_BROWSER_TIMEOUT_MS` / `PROXY_BROWSER_SETTLE_MS` を検証して `{ waitUntil, timeoutMs, settleMs }` を返す（不正値は既定へフォールバック。`debug-browser.mjs` と同方針、#39） |
| `cookieToSetCookie(cookie)`     | Playwright の cookie オブジェクトを `Set-Cookie` 文字列へ変換する。`Domain` は付けず（`sanitizeSetCookie` がスコープ化）、`Path` / `Secure` / `HttpOnly` / `SameSite` / 永続 cookie の `Expires` を反映する   |

### CSSOM スタイルの実体化（DOM 操作関数・#120）

> 関連仕様: [プロキシ機能仕様 §browserFetch の振る舞い](../spec/features/proxy.md#browserfetch-の振る舞い)。対応 Issue: [#120](https://github.com/f8924919/web-proxy/issues/120)。

`page.content()` は DOM テキストのみをシリアライズし、CSSOM（`insertRule`）注入の CSS や `adoptedStyleSheets` を出力しない。CSS-in-JS サイト（例 news.yahoo.co.jp）はクライアントで CSS を CSSOM に直接注入し `<style>` を空にするため、取得 DOM から CSS が欠落しレイアウトが崩れる。これを防ぐため、`page.content()` の直前に DOM を実体化する。

| 関数                     | 役割                                                                                                                                                                                                                                                                                                                     |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `inlineCssomStyles(doc)` | 各 `<style>` の `sheet.cssRules` を結合して `<style>` テキストへ書き戻す（テキストが CSSOM ルールより短い場合のみ＝冪等）。`doc.adoptedStyleSheets` の各シートのルールを `<style data-proxy-adopted>` として `<head>` へ出力する。`cssRules` を読めないシート（cross-origin 等）は例外を握り潰してスキップし全損させない |

- **配線**: `browserFetch` で `page.content()` を呼ぶ直前に `page.evaluate(inlineCssomStyles)` を実行する。`inlineCssomStyles` は外部参照を持たず DOM グローバルのみで完結させる（`page.evaluate` がブラウザ context で実行するため。`doc` 引数の既定値はブラウザの `document`）。ブラウザティアでは常時実行（env フラグなし）。
- **テスト**: `inlineCssomStyles` を `document` 互換オブジェクトに対する単体テストで検証する。`page.evaluate` の I/O 配線は[テスト方針](../testing/policy.md)によりテスト対象外。

### ブラウザ実行基盤の差し替え（純粋関数 + `getBrowser`・#71）

> 関連仕様: [プロキシ機能仕様 §ブラウザ実行基盤](../spec/features/proxy.md#ブラウザ実行基盤バックエンドの差し替え71)。比較・デプロイは [setup.md §9](../setup.md#9-本番デプロイブラウザ実行基盤71)。

`browserFetch` の**インターフェース契約（`(url, options?) => {response, finalUrl}`）を不変**に保ったまま、ブラウザの実行場所だけを差し替えられるようにする。差し替え接合点は `getBrowser()` の 1 関数のみ。

| 純粋関数                     | 役割                                                                                                              |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `browserBackendFromEnv(env)` | `PROXY_BROWSER_CDP_URL` があれば `{ mode: "cdp", endpoint }`、無ければ `{ mode: "launch" }` を返す（既定 launch） |

- **`getBrowser()` の分岐**: `mode==="cdp"` なら `chromium.connectOverCDP(endpoint)`（外部サービス）、`launch` なら `chromium.launch()`（自前 Chromium 同梱）。いずれも `Browser` 型を返すため呼び出し側は不変。
- **切断時の再接続**: 取得した `Browser` の `disconnected` で共有参照（`sharedBrowser`）を `null` に戻し、次回呼び出しで再接続させる（外部 CDP は idle 切断し得るため。launch も同様にクラッシュ復帰）。`isConnected()` チェックと併用。
- **同時実行・タイムアウト・リーク防止（本番）**: `PROXY_BROWSER_MAX_CONCURRENCY`（既定 2）の簡易セマフォ、`PROXY_BROWSER_TIMEOUT_MS`（既定 15000）、context はリクエスト単位で `finally` に `close()`（ブラウザは再利用）。本番想定値は [setup.md §9](../setup.md#9-本番デプロイブラウザ実行基盤71) を参照。

### アンチボット対策（egress IP プロキシ / stealth・#73）

> 関連仕様: [プロキシ機能仕様 §アンチボット対策](../spec/features/proxy.md#アンチボット対策egress-ip--stealth73)。

egress IP が支配的なため、最小実装に留める（突破は保証しない）。

| 純粋関数 / 定数            | 役割                                                                                                                                                                                         |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `browserProxyFromEnv(env)` | `PROXY_BROWSER_PROXY_SERVER`（+ 任意 `..._PROXY_USERNAME` / `..._PROXY_PASSWORD`）から Playwright の `{ server, username?, password? }` を組み立てる。未設定なら `undefined`（プロキシ無し） |
| `STEALTH_LAUNCH_ARGS`      | 自前 `chromium.launch()` に渡す Chrome フラグ（`--disable-blink-features=AutomationControlled`）                                                                                             |
| `STEALTH_INIT_SCRIPT`      | 全 context に注入する init script（`navigator.webdriver` を隠す）                                                                                                                            |

- **egress IP（プロキシ経路）**: `getBrowser()` の `launch` 分岐で `browserProxyFromEnv()` が非 `undefined` なら `chromium.launch({ proxy, ... })` に渡す（ブラウザ全体に適用）。CDP 分岐は外部サービス側の IP プールに委ねるため適用しない。SSRF ガード（`installSsrfGuard`）は上流プロキシ有無に関わらず維持。
- **stealth（launch のみ・args）**: `launch` 分岐で `STEALTH_LAUNCH_ARGS` を付与。CDP（外部サービス）はサービス側 stealth に委ねるため args は渡せない（接続のみ）。
- **stealth（両バックエンド・init script）**: `browserFetch` の `newContext` 直後に `context.addInitScript(STEALTH_INIT_SCRIPT)` を呼ぶ。launch / CDP の両方で各ページのスクリプト実行前に `navigator.webdriver` を隠す。
- **テスト**: `browserProxyFromEnv`（純粋関数）と stealth 定数の内容を単体テスト対象とする。`launch`/`addInitScript` の I/O 配線は[テスト方針](../testing/policy.md)によりテスト対象外。

### `browserFetch(url, options?)`（ランタイム配線・I/O）

- **Playwright は遅延ロード**（`await import("playwright")`）。ティアが使われない限り読み込まない（バンドル肥大・常時ロードを避ける）。バックエンドは `getBrowser()` が `browserBackendFromEnv()` に従い launch / CDP を選ぶ（#71）。
- **SSRF**: 初回ナビゲーション URL に `assertSsrfAllowed`（`fetch.ts` から公開）を適用し、ブラウザの**全サブリクエスト**にも `context.route` 傍受で**全アドレス（A / AAAA）**のブロックリスト照合（IPv4 / IPv6 両対応）を適用する（1 つでもブロック対象なら中断）。ただし Chromium の接続時再解決のため IP ピン留めはできず、リバインディングの残存窓がある（[機能仕様 §SSRF（不弱化）](../spec/features/proxy.md#ssrf不弱化)）。
- **コンテキスト**: 既定 UA（`PROXY_USER_AGENT` で上書き可、`fetch.ts` の `DEFAULT_USER_AGENT`）と `options.headers`（`Cookie` / `Authorization` 等）を `extraHTTPHeaders` として適用し、リクエストごとに新規 context を作って分離する。
- **取得**: `page.goto`（`resolveBrowserWaitConfig` の待機）→ settle 待ち → `page.content()`（本文）/ `page.url()`（finalUrl）。失敗時もベストエフォートで収集して返す。
- **Cookie ウォーミング**: `context.cookies()` を `cookieToSetCookie` で `Set-Cookie` 化し、`text/html` の `Response` ヘッダーへ載せる。以降は `relayBrowse` の `sanitizeHeaders` が既存どおりスコープ化する。
- **ライフサイクル**: ブラウザはプロセス内で再利用し、context はリクエストごとに作って確実に close する。同時実行数を上限（`PROXY_BROWSER_MAX_CONCURRENCY`、既定 2）で絞る。
- **テスト**: 純粋関数（上記）のみ単体テスト対象。ブラウザ I/O は[テスト方針](../testing/policy.md)によりテスト対象外。
- **既知の制約（#123）**: 配信する `page.content()` は hydration 後の DOM のため、クライアントの再 hydration で React の hydration エラー（`#418` 等）が console に多発する。実害なし（コンソールノイズ）と切り分け済みで、低減策は体験を壊すリスクから意図的に見送る。詳細は[機能仕様 §既知の制約: クライアント再 hydration](../spec/features/proxy.md#既知の制約-クライアント再-hydration123)。

---

## `src/lib/proxy/promotion.ts`

> 関連仕様: [プロキシ機能仕様 §ヒューリスティック自動ティア昇格](../spec/features/proxy.md#ヒューリスティック自動ティア昇格崩れチャレンジ検出)。対応 Issue: [#70](https://github.com/f8924919/web-proxy/issues/70)。

**役割**: 中継ティア（`proxyFetch`）の初回応答から「崩れ / チャレンジ」を検出し、ブラウザティアへ自動昇格すべきかを判定する。明示 allowlist（`shouldUseBrowser`）を**補助**するヒューリスティックで、`browserFetch.ts` のティア判定とは独立したモジュールに切り出す。

### 昇格判定・有効化（純粋関数）

| 純粋関数                                            | 役割                                                                                                                                                                |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `autoPromoteEnabledFromEnv(env)`                    | `PROXY_BROWSER_AUTO_PROMOTE`（`true` / `1` / `on` で有効、既定無効）を解釈する                                                                                      |
| `shouldPromoteToBrowser(html, status, contentType)` | `text/html` 応答について、チャレンジ語句 / `<noscript>` 主体 / `403`・`503` のいずれかを検出したら `true`。非 HTML は常に `false`（空 body 単独は判定材料にしない） |

- **チャレンジ語句**: `enable javascript` / `enablejs` / `checking your browser` / `recaptcha` / Cloudflare チャレンジ等の語句を本文（小文字化）に含むか判定する。
- **`<noscript>` 主体**: `<noscript>` を含み、かつ `<script>` / `<style>` / `<noscript>` を除いた可視テキストが極小であるかで判定する。

### 再昇格抑止（`PromotionGuard`・インメモリ状態）

- 同一 URL（`ホスト + パス` 単位・**クエリ無視**）を短時間ウィンドウ内で一度昇格したら再昇格しないことで、`proxyFetch` → `browserFetch` の二重取得を URL あたり高々 1 回 / ウィンドウに制限する。
- `loopGuard.ts` / `rateLimit.ts` と同じ `Map<key, timestamps[]>` のスライディングウィンドウ方式（既定ウィンドウ 60 秒、プロセス再起動でリセット）。
- 共有インスタンス `promotionGuard` を `route.ts` が利用する。`tryPromote(target)` は再昇格可なら記録して `true`、抑止中なら `false` を返す。
- **テスト**: 純粋関数（`autoPromoteEnabledFromEnv` / `shouldPromoteToBrowser`）と `PromotionGuard` のウィンドウ挙動を単体テスト対象とする（[テスト方針](../testing/policy.md)）。`browserFetch` 本体（I/O）はテスト対象外。

---

## `src/lib/proxy/rewrite.ts`

**役割**: HTML / CSS の URL を書き換える。

### HTML 書き換え（`node-html-parser` 使用）

相対 URL は `baseUrl` を基準に絶対 URL へ変換してからエンコードする。

| 対象                               | 書き換え先                                                      |
| ---------------------------------- | --------------------------------------------------------------- |
| `<a href>`                         | `/browse/<scheme>/<host>/<path>`                                |
| `<form action>`                    | `/browse/<scheme>/<host>/<path>`                                |
| `<img src>` / `<source src>`       | `/api/proxy/<scheme>/<host>/<path>`                             |
| `<img srcset>` / `<source srcset>` | 各候補 URL を `/api/proxy/<scheme>/<host>/<path>`（記述子保持） |
| `<link href>`                      | `/api/proxy/<scheme>/<host>/<path>`                             |
| `<script src>`                     | `/api/proxy/<scheme>/<host>/<path>`                             |
| `<meta http-equiv=refresh>`        | `/browse/<scheme>/<host>/<path>`                                |

> アセット系（`<img>`/`<link>`/`<script>`/`srcset`/CSS）は `assetUrl()` → `proxyPath.ts` の `buildProxyPath()`（`/api/proxy/...`・#100）、ナビゲーション系（`<a>`/`<form>`/meta refresh）は `browseUrl()` → `browsePath.ts` の `buildBrowsePath()`（`/browse/...`・#115）でパス反映形式に組み立てる（[機能仕様 §プロキシ URL スキーム](../spec/features/proxy.md#プロキシ-url-スキームパス反映)）。両者は同形のスキームで、`%2F`/非 ASCII の percent-encoding を保持する（#111）。

`<meta http-equiv="refresh" content="<遅延>;url=<TARGET>">` は `content` 内の `url=` を正規表現で抜き出し、`<a href>` と同じ `browseUrl()` で書き換える（遅延値は保持）。ルート相対 `url` がプロキシオリジン直下へ解決されて離脱するのを防ぐ。`<noscript>` 内の meta refresh はパーサが生テキスト扱いするため対象外（[機能仕様 §meta refresh の書き換え](../spec/features/proxy.md#meta-refresh-の書き換え)の制限）。

`<img>` / `<source>` の `srcset` は純粋関数 `rewriteSrcset(value, baseUrl)` で各候補に分解し、URL 部のみ `assetUrl()` で書き換え記述子を保持して再結合する。WHATWG srcset 解析に準じ URL 部を空白以外の連続文字として取り出すため `data:` URL 内のカンマで誤分割しない（[機能仕様 §srcset の書き換え](../spec/features/proxy.md#srcset-の書き換え)）。Next.js 製サイトの `<Image>` が出力する `/_next/image?url=…` をプロキシ origin 直下の最適化エンドポイントへ解決させず（400 回避）、上流の最適化 URL を中継する（#98）。

`src` を書き換える `<script>` からは `integrity` / `crossorigin` 属性を除去する。書換後は `/api/proxy` 経由の中継レスポンスとなり SRI ハッシュが一致せずブロックされるため（[機能仕様 §SRI 属性の除去](../spec/features/proxy.md#サブリソース整合性sri属性の除去)）。あわせて inline の `<meta http-equiv="Content-Security-Policy">`（enforce のみ。`...-Report-Only` は残す）を除去し、注入スクリプト・書換 src が CSP でブロックされるのを防ぐ（[機能仕様 §inline CSP（meta）の除去](../spec/features/proxy.md#inline-cspmetaの除去)）。

### CSS 書き換え

正規表現で `url(...)` と `@import` を `assetUrl()`（パス反映形式 `/api/proxy/<scheme>/<host>/<path>`）へ置換。

### アドレスバー注入

`rewriteHtml` は URL 書き換えに加え、アドレスバー HTML スニペットを `<body>` 直後に注入する。バーは `position: fixed`、直後のスペーサー `#proxy-addressbar-spacer` の高さをバー実高へ同期してコンテンツの重なりを防ぐ（#108。詳細は前段の[アドレスバー注入](#アドレスバー注入)を参照）。

注入スニペット `ADDRESS_BAR_HTML` は最終 URL（`currentUrl`）を `<input value="…">` へ埋め込む。この値は汎用関数 `escapeHtml`（`rewrite.ts`）で `& < > " '` を一括して HTML 実体参照へエスケープしてから差し込む。`currentUrl` は `new URL` 正規化済みで属性ブレイクアウト自体は塞がれているが、`&`（クエリ区切り）や `< > '` は URL 文法上そのまま含まれ得るため、出力エンコードの欠落による XSS（CWE-116）を防ぐ目的で一括エスケープを行う（#137）。

### GET フォーム送信横取りスクリプト注入

> 関連仕様: [プロキシ機能仕様 §GET フォーム送信の横取り](../spec/features/proxy.md#get-フォーム送信の横取り)

`rewriteHtml` は `<body>` 直後（アドレスバー・SW 登録に続けて）に、GET フォーム送信を横取りする `<script>` を注入する。パス反映ナビ形式（#115）では `action` がターゲットを**パス部**に持つため GET 送信でも消失しないが、SPA（React 等）が自前 submit ハンドラで実サイトへ後勝ち遷移する（#93）のを阻止するため横取りは維持する。

注入スクリプトは 2 経路で捕捉する。いずれも振り向け先の決定は純粋関数 `buildGetFormDestination`（＋共有ヘルパー `extractBrowseTarget` / `browseNavPrefix` / `buildBrowseDest`）を共用する。

```
(A) document に submit を capture で委任（動的フォーム・ネイティブ submit・requestSubmit にも効く）:
0. 自前のアドレスバー（#proxy-addressbar 内のフォーム）は独自 onsubmit を持つため除外
1. method が GET 以外 → 何もしない（POST 等はそのまま素通し）
2. 送信フォームの action（パス反映 …/browse/<scheme>/<host>/<path>）からターゲットを復元する
   （action から復元不可なら window.location から復元。後方互換で旧 ?url= 形式も復元可）
3. preventDefault + stopImmediatePropagation（SPA の自前 submit ハンドラ阻止。#93）し、
   ターゲットのクエリ全体を FormData（フォーム項目）で置き換える
4. パス反映プレフィックス（BASE_PATH 込みの …/browse/）を再利用し、
   <prefix><scheme>/<host>/<path>?<再構築クエリ> へ window.location.href で遷移する

(B) HTMLFormElement.prototype.submit のオーバーライド（#78）:
- form.submit()（プログラム送信）は submit イベントを発火しないため (A) で捕捉できない
  （例: Google 検索）。prototype を上書きして同じ buildGetFormDestination を適用する。
- 自前アドレスバー / GET 以外 / 復元不可（dest が null）/ 例外時は、元の submit を
  そのまま呼ぶ（挙動を変えない）。dest が得られた場合のみ location.href で遷移する。
```

`BASE_PATH` とパス反映プレフィックスは `action`/`window.location` から再利用することで保持される（スクリプト内で BASE_PATH を個別に組み立てない）。`location.assign` / `history` 駆動の純粋な JS ナビゲーション（フォームを介さない）は対象外。

### クライアント側ナビゲーション横取りスクリプト注入

> 関連仕様: [プロキシ機能仕様 §クライアント側ナビゲーションの横取り](../spec/features/proxy.md#クライアント側ナビゲーションの横取り)

`rewriteHtml` は `<body>` 直後（GET フォーム横取りに続けて）に、`<a>` クリックによるナビゲーションを横取りする `<script>` を注入する。サーバー側 `<a href>` 書き換えは初期 HTML を一度書き換えるだけで、(1) JS が動的描画したリンク（生の絶対/相対 URL）は対象外、(2) SPA（React 等）が `<a>` クリックを onClick ルーターで奪い `history.pushState` で遷移する、のいずれでも実サイトへ離脱するため、それを補う（#82）。`location`/`history` API はブラウザ仕様で改変不能（[機能仕様 §クライアント側ナビゲーションの横取り](../spec/features/proxy.md#クライアント側ナビゲーションの横取り)）なので、フックではなく**クリックの主導権を奪う**方式を採る。

振り向け先 URL の決定は純粋関数 **`buildClickNavDestination(href, pageUrl)`** に分離し、`GET_FORM_INTERCEPT_HTML` と同様 `toString()` で `<script>` に埋め込む（外部参照を持たず `URL` のみで完結）。

```
document に click を capture で委任（動的リンクにも効き、SPA の onClick より先に発火）:
0. 修飾キー(Ctrl/Meta/Shift/Alt)・補助ボタン(中クリック)・defaultPrevented は素通し
1. event.target から closest('a[href]') で最寄りの <a href> を探す（無ければ素通し）
2. closest('#proxy-addressbar') 内（自前 UI）・target="_blank" は素通し
   （新規タブはブラウザ標準挙動を尊重＝離脱は既知の制限）
3. buildClickNavDestination(href, location.href):
   - href を location.href 基準で解決し、http(s) 以外・# アンカーは null
   - 現ターゲットは location（パス反映ナビ形式 …/browse/<scheme>/<host>/… のマーカー以降）
     から復元。後方互換でリダイレクト前の …/browse?url= 形式は url= からも復元
   - 外部オリジンの絶対 URL（プロトコル相対含む）→ 当該絶対 URL をパス反映ナビ形式へ
   - 同一オリジンの書き換え済み browse リンク（…/browse/<scheme>/<host>/… 形式、または
     後方互換の …/browse パスかつ url= 付き）→ その path+search+hash をそのまま返す
   - 同一オリジンのその他パス（/articles/… 等）・クエリのみ相対（?q=… ・#114）→ 現ターゲットを
     base に解決し直してパス反映ナビ形式へ（ターゲット復元不可なら null）
   - パス反映プレフィックス（BASE_PATH 込みの …/browse/）は location から再利用
4. dest があれば preventDefault + stopImmediatePropagation（SPA ルーターの横取り阻止）し
   location.href = dest で遷移
```

`BASE_PATH` とパス反映プレフィックスは `window.location` から再利用することで保持される（GET フォーム横取りと同方式）。リンククリックを伴わない `location`/`history` API 駆動の JS 遷移は依然対象外（ブラウザ仕様上フック不能。完全対応は RBI #72）。本方式は同一サイト内の SPA クライアントルーティングもフルナビゲーション化するトレードオフを持つ（spec 参照）。

### `document.domain` ドメインガード無効化シム注入

> 関連仕様: [プロキシ機能仕様 §`document.domain` ドメインガードの無効化](../spec/features/proxy.md#documentdomain-ドメインガードの無効化)

`rewriteHtml` は、ターゲットの**ホスト名（`new URL(baseUrl).hostname`）を返すよう `document.domain` を見せかけるシム `<script>`** を、ページ内スクリプトより先に実行されるよう **`<head>` 最先頭**へ注入する（他の注入が `<body>` 直後なのに対し、本シムだけは `<head>` 先頭）。一部サイト（例 Yahoo の `yjsecure.js`）が `document.domain` を正規表現で検査し、自オリジン外と判定するとトップフレームを実サイトへリダイレクトするため、プロキシ配下（`document.domain` がプロキシのホスト名）でガードが誤発火するのを防ぐ。

- **実装方式**: `Object.defineProperty(Document.prototype, 'domain', { get: () => <hostname>, set: () => {} })` で getter を上書きする（代入方式は `Origin-Agent-Cluster` 等で禁止され得るため不採用）。`try/catch` で例外を吸収する。
- **注入位置と最先頭性**: `yjsecure.js` は `templa.min.js` が `<head>` 段階で動的挿入し得るため、`<body>` 直後注入では間に合わない。`<head[^>]*>` 直後へ正規表現置換で注入する。`<head>` が無い HTML は `<html>` 直後、それも無ければ文書先頭へフォールバックする。
- **スコープ外**: `location.hostname` / `location.href` など `location` 全体を偽装する汎用シムは対象外（`document.domain` ベースのガード無効化に範囲を限定）。

### 実行時リクエスト横取りシム注入（SW 非依存・#124）

> 関連仕様: [プロキシ機能仕様 §実行時リクエスト横取りシム](../spec/features/proxy.md#実行時リクエスト横取りシムsw-非依存124)

`rewriteHtml` は、`window.fetch` と `XMLHttpRequest.prototype.open` を上書きしてリクエスト URL を `/api/proxy/<scheme>/<host>/<path>` へ書き換える横取りシム `<script>` を、ページ内スクリプトより先に実行されるよう **`<head>` 最先頭**へ注入する（`document.domain` シムと同様）。SW は初回ロードで `clients.claim()` 確立前のサブリソース要求を横取りできず、同一オリジン相対は 404・クロスオリジン XHR は CORS 失敗する。本シムは SW 制御の有無に依らずこのギャップを埋める。

| 純粋関数                                                            | 役割                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `isProxyOwnPath(pathname, basePath)`                                | 横取りしてはいけないプロキシ自前ルート（`/browse`・`/api/proxy/*`・`/_next/*`〔`/_next/image` を除く〕・`/sw.js`・`/favicon.ico`・ホーム）か判定する（`public/sw.js` の同名関数と対の規則）                                                                          |
| `buildRequestInterceptUrl(requestUrl, pageUrl, swOrigin, basePath)` | リクエスト URL を SW の `rewriteRequestUrl` と同一規則で `/api/proxy/<scheme>/<host>/<path>` へ書き換える。クロスオリジン絶対 URL はそのまま中継、同一オリジン非自前パスは閲覧ページからターゲット origin を復元して解決、自前ルート・非 http(s) は `null`（素通し） |

- **共有ヘルパー**: ターゲット復元は既存の純粋関数 `extractBrowseTarget` を再利用する。`buildRequestInterceptUrl` / `isProxyOwnPath` / `extractBrowseTarget` を `toString()` で `<script>` に埋め込む（外部参照を持たず `URL` のみで完結）。
- **SW との非競合**: シムの振り向け先（同一オリジンの `/api/proxy/...`）は SW が自前ルートと判定して素通しするため二重書き換えにならない。判定規則は `public/sw.js` と揃え、差分が出ないよう対で保守する（SW は `importScripts` 不可のためロジック共有はできず、両ファイルに同等実装を持つ）。
- **fetch / XHR の配線**: `fetch` シムは `input` が文字列・`URL`・`Request` のいずれでも URL を取り出して書き換える（`Request` は新 `Request` で再構築）。XHR シムは `open(method, url)` の `url` を書き換える。いずれも非 GET のメソッド・ボディ・ヘッダーを保持する。書き換え不要（`null`）なら元の `fetch` / `open` を素通しする。
- **テスト**: `isProxyOwnPath` / `buildRequestInterceptUrl`（純粋関数）を単体テスト対象とする。`window.fetch` / XHR の上書き配線（ブラウザ I/O）は[テスト方針](../testing/policy.md)によりテスト対象外。

---

## Service Worker: `public/sw.js`

> 関連仕様: [プロキシ機能仕様 §Service Worker による実行時リクエスト横取り](../spec/features/proxy.md#service-worker-による実行時リクエスト横取り)

**役割**: 閲覧ページ内で JS が実行時に発行するリクエスト（**ナビゲーションを除く全メソッド**）を横取りし、`/api/proxy` 経由へ振り向ける。サーバー側 `rewriteHtml` が捕捉できない動的ロード（画像・スクリプト・XHR・非 GET API 呼び出し）を補完し、同一オリジン化により CORS プリフライトを消す（[機能仕様 §CORS プリフライト対応](../spec/features/proxy.md#cors-プリフライト対応)）。

### 登録

`rewriteHtml` が閲覧ページの `<body>` 直後（アドレスバーに続けて）に登録用 `<script>` を注入する。登録 URL は `${BASE_PATH}/sw.js`、スコープは `${BASE_PATH}/`。

- SW スクリプトは `self.registration.scope` から自身の `BASE_PATH` を導出する（リバースプロキシのパスプレフィックス対応。`next.config.mjs` は `basePath` 未使用のため、ブラウザから見えるスコープ＝プレフィックス込みのパスになる）。

### `fetch` ハンドラの処理

```
1. request.mode === "navigate" → 素通し（ページ遷移・フォーム送信に委ねる）
2. 同一オリジンの自前ルート（/browse・/api/proxy・/_next/* 等。ただし /_next/image を除く）→ 素通し
3. clientId から要求元ページ URL（パス反映 /browse/<scheme>/<host>/<path>・後方互換 /browse?url=<target>）を取得し、extractTarget でターゲットを復元する
4. rewriteRequestUrl(requestUrl, pageUrl, swOrigin, basePath) で振り向け先を決定
   （振り向け先はパス反映形式 /api/proxy/<scheme>/<host>/<path>。#100）
   - クロスオリジンの絶対 URL → /api/proxy/<scheme>/<host>/<path>
   - 同一オリジンのルート絶対パス（自前ルート以外）→ ターゲット origin に解決し /api/proxy/<scheme>/<host>/<path>
   - 同一オリジンの /_next/image → ターゲット origin の /_next/image に解決し /api/proxy/<scheme>/<host>/_next/image?...（#102）
   - 自前ルート（パス反映済みの相対 import /api/proxy/* を含む）→ 素通し（null）
5. 振り向け先があれば fetch で応答（非 GET はメソッド・ボディ・リクエストヘッダーを保持、
   credentials: "same-origin"）。なければ素通し。振り向け fetch が失敗しても未処理 reject に
   せず Response.error() を返す
```

> メソッド非依存の URL 書き換えは純粋関数 `rewriteRequestUrl` が担い（メソッドで分岐しない）、非 GET のボディ・ヘッダー保持は `fetch` ハンドラ（ランタイム配線）側で行う。

`isProxyOwnPath` は `/_next/` を原則プロキシ自身の資産として素通し扱いにするが、`/_next/image` だけは「自前ルートでない」と判定し、`rewriteRequestUrl` の既存フォールバック（同一オリジンの非自前パス → ターゲット origin に解決）へ委ねる。Next.js 製ターゲットのクライアント hydration が再生成する `/_next/image?url=<外部>` をターゲット自身の最適化エンドポイントへ中継して 400 を防ぐ（#102。サーバー描画分の `srcset` は #98 で対応済み）。ターゲット不明のページ（ホーム等）では `extractTarget` が `null` を返し素通しされるため、プロキシ自身の `/_next/image` 利用には影響しない（[機能仕様 §Service Worker](../spec/features/proxy.md#service-worker-による実行時リクエスト横取り)）。

### 純粋ロジックの分離とテスト

横取り判定・URL 解決・`/api/proxy` への書き換えは純粋関数として `public/sw.js` 内に定義し、`module.exports`（CommonJS）で公開する。SW ランタイム配線（`addEventListener('fetch', ...)`）は `importScripts` の有無で**ガード**し、Node（テスト）環境では実行されないようにする。これにより、配信される SW 本体の純粋ロジックを Node 環境のテストで直接検証でき、ロジックの重複を避ける（[テスト方針](../testing/policy.md) / `tests/lib/proxy/sw-intercept.test.ts`）。

### 制約（MVP）

- **ナビゲーションは対象外**。ページ遷移・フォーム送信はサーバー側書き換えに委ねる。
- **`credentials: "same-origin"` で振り向け**。振り向け先は常に同一オリジンの `/api/proxy` であり、プロキシ origin に保存されたターゲットのスコープ Cookie が `/api/proxy` まで届く。これにより `credentials: "include"` 相当の Cookie ベース・クロスオリジン XHR が、上流転送のスコープ抽出（`scopedCookieHeader`）で現ターゲット分だけに限定されたうえで成立する（#28。[機能仕様 §認証情報の転送 §セキュリティ上の制約](../spec/features/proxy.md#セキュリティ上の制約-1)）。プロキシ自身のインフラ認証 cookie（Cloudflare Access の `CF_Authorization` 等）は非スコープのため上流転送から除外される。元リクエストの `credentials` モードは区別せず一律 `same-origin` で振り向ける（既知の制約は同機能仕様を参照）。
- **ランタイム相対 module import はパス反映で解消（#100）**。アセットがパス反映形式（`/api/proxy/<scheme>/<host>/<path>`）で配信されるため、チャンク分割 SPA の相対 import はブラウザがモジュールのディレクトリ基準で正しく解決し、自前ルートとして素通しされルートが中継する（[機能仕様 §プロキシ URL スキーム](../spec/features/proxy.md#プロキシ-url-スキームパス反映)）。残る best-effort はクロスオリジン module からのルート絶対参照（referrer 不在のためページ target origin に振り向ける）。

---

## `src/lib/proxy/headers.ts`

**役割**: ターゲットのレスポンスヘッダーから不要なものを除去する。加えて、リクエスト側で転送する認証ヘッダーの抽出と、サイト間 Cookie アイソレーションのための Cookie スコープ化も担う。

除去対象（`Speculation-Rules` を含む）は [プロキシ機能仕様 §レスポンスヘッダー処理](../spec/features/proxy.md) を参照。前段 CDN が後段で注入する `Speculation-Rules` はコードからは除去できないため CDN 側設定で無効化する（同仕様の注記参照）。

### `cookieScopeKey(origin)`

> 関連仕様: [プロキシ機能仕様 §サイト間 Cookie アイソレーション](../spec/features/proxy.md#サイト間-cookie-アイソレーション)

ターゲット origin（`scheme://host[:port]`）から Cookie 名へ付与するスコープ鍵（`base64url(origin)`）を生成する純粋関数。`URL.origin` は IDN を punycode 化するため ASCII で、Cookie 名 token に使える文字のみになる。区切りに `.` を使うため、base64url が `.` を含まないことを利用して復元時に鍵と元の名前を分離する。

### `sanitizeHeaders(headers, targetOrigin)` / `sanitizeSetCookie(value, targetOrigin)`

> 関連仕様: [プロキシ機能仕様 §認証情報の転送](../spec/features/proxy.md#認証情報の転送cookie--authorization) / [§サイト間 Cookie アイソレーション](../spec/features/proxy.md#サイト間-cookie-アイソレーション)

`sanitizeHeaders` はレスポンスヘッダーをサニタイズし、`Set-Cookie` は `sanitizeSetCookie` へ委譲する。`sanitizeSetCookie` は `Domain` 属性を除去したうえで Cookie 名を `__pxy.<cookieScopeKey(targetOrigin)>.<元の名前>` へスコープ化する（`Path` / `Secure` / `SameSite` は維持）。`targetOrigin` にはリダイレクト追従後の**最終 URL の origin**を渡す（書き換え基準 `baseUrl` と揃える、#42）。

### `scopedCookieHeader(cookieHeader, targetOrigin)`

> 関連仕様: [プロキシ機能仕様 §サイト間 Cookie アイソレーション](../spec/features/proxy.md#サイト間-cookie-アイソレーション)

受信 `Cookie` ヘッダー値から、`targetOrigin` のスコープ鍵に一致する `__pxy.<鍵>.` 接頭辞を持つ Cookie だけを抽出し、接頭辞を外して元の名前で連結する純粋関数。別 origin にスコープされた Cookie・非スコープの Cookie（プロキシ自身のインフラ認証 cookie 等）は除外される。残る Cookie が無ければ空文字を返し、呼び出し側は `Cookie` ヘッダーを付けない。`forwardableRequestHeaders` / `relayRequestHeaders` の両方が往路 `Cookie` の処理に用いる。

### `authorizationAllowed(incoming, targetOrigin)` / `originFromProxiedReferer(referer)`

> 関連仕様: [プロキシ機能仕様 §Authorization のオリジンスコープ](../spec/features/proxy.md#authorization-のオリジンスコープ136)

`Authorization` を宛先ターゲット origin へスコープするための判定ヘルパー（#136）。`originFromProxiedReferer(referer)` は受信 `Referer` 文字列を `URL` としてパースし、その `pathname` / `search` から `targetFromBrowsePath` → `targetFromProxyPath` → 後方互換 `?url=` の順で中継元ターゲット絶対 URL を復元し、その `origin` を返す純粋関数（復元不能なら `null`）。`authorizationAllowed(incoming, targetOrigin)` は `originFromProxiedReferer(incoming.get("referer"))` が `targetOrigin` と**完全一致**する場合のみ `true` を返す（`Referer` 欠落・パース不能・不一致はすべて `false` ＝ fail-closed）。`forwardableRequestHeaders` / `relayRequestHeaders` の両方が往路 `Authorization` の転送可否に用いる。

### `forwardableRequestHeaders(incoming, targetOrigin)`

> 関連仕様: [プロキシ機能仕様 §認証情報の転送](../spec/features/proxy.md#認証情報の転送cookie--authorization)

受信リクエストの `Headers` から、ターゲットへ転送してよい認証ヘッダーを**許可リスト**（`Cookie` / `Authorization`）で抜き出し `Record<string, string>` で返す純粋関数。存在するヘッダーのみを含める。全ヘッダー素通しを避け、転送対象を明示的に限定する。`GET` 中継（`/browse` GET / `/api/proxy` GET）が `proxyFetch` の `options.headers` へ渡す（`/browse` POST は `content-type` も併せて渡す）。`Cookie` は `scopedCookieHeader(_, targetOrigin)` で現ターゲット origin 分だけに限定する。`Authorization` は `authorizationAllowed(incoming, targetOrigin)`（中継元 `Referer` 由来オリジンと `targetOrigin` の完全一致判定）が真のときのみ転送する（#136）。

### `relayRequestHeaders(incoming, targetOrigin)`

> 関連仕様: [プロキシ機能仕様 §CORS プリフライト対応](../spec/features/proxy.md#cors-プリフライト対応)

SW が `/api/proxy` へ振り向けた**非 GET 中継**向けに、リクエストヘッダーを**拒否リスト方式**で広めに転送する純粋関数。hop-by-hop・インフラ系（`host` / `connection` / `content-length` / `transfer-encoding` / `keep-alive` / `te` / `upgrade` / `accept-encoding`）に加え、プロキシ自身の文脈を漏らす `origin` / `referer` を除外し（#27）、`Content-Type` / `Authorization` / `Cookie` / `X-*` 等を残す。`X-CSRF-Token` などカスタムヘッダー依存の API を動かすため、許可リスト（`forwardableRequestHeaders`）より広く取る。残す `Cookie` は `scopedCookieHeader(_, targetOrigin)` で現ターゲット origin 分だけに限定する。`Authorization` はサーバー側のスコープ機構が無いため、`authorizationAllowed(incoming, targetOrigin)`（中継元 `Referer` 由来オリジンと `targetOrigin` の完全一致判定）が真のときのみ転送する（#136）。

### `allowedCorsOrigin(origin, host)`

> 関連仕様: [プロキシ機能仕様 §CORS プリフライト対応](../spec/features/proxy.md#cors-プリフライト対応)

要求 `Origin` が `/api/proxy` リクエスト自身の `Host` と**同一オリジン**の場合のみその `origin` を返し、不一致・いずれか欠落・不正値なら `null` を返す純粋関数（#27）。`Host` は scheme を含まないため `new URL(origin).host` の host 部のみで照合する（TLS 終端リバプロでも公開 Host 同士で一致する）。SW が正当なサブリソースを同一オリジンの `/api/proxy` へ振り向けるため、許可すべきは自プロキシ origin のみ。OPTIONS 応答・中継レスポンスの CORS 許可判定に用いる。

### `buildCorsPreflightHeaders(origin, requestHeaders)`

> 関連仕様: [プロキシ機能仕様 §CORS プリフライト対応](../spec/features/proxy.md#cors-プリフライト対応)

`OPTIONS` 応答用の CORS 許可ヘッダー（`Access-Control-Allow-Methods/-Headers`・`Max-Age`・`Vary`、および許可時の `Access-Control-Allow-Origin/-Credentials`）を組み立てる純粋関数。`origin` は呼び出し側が `allowedCorsOrigin` で検証済みの値（許可 Origin または `null`）を渡す。**`origin` が非 null の場合のみ** `Access-Control-Allow-Origin` をエコーし `Allow-Credentials: true` を付ける（無検証エコー・`*` フォールバックは行わない。#27）。`Access-Control-Request-Headers` は従来どおりエコーする（無ければ `*`）。

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

**eviction（#132）**: `check` 冒頭で、前回 eviction から `windowMs` 以上経過していれば `store` を走査し、全タイムスタンプがウィンドウ外（空）になったエントリを `delete` する。走査は `windowMs` ごとに間引くため毎リクエストの全走査は発生しない。テスト用に現在のエントリ数を返す `size` ゲッターを公開する。`ip` には `getClientIp` の解決値（信頼ヘッダー未設定時は定数 `"unknown"`）が渡る。

> 上限値の根拠・分離の理由は [機能仕様 §レート制限](../spec/features/proxy.md#レート制限)、IP 解決・eviction は [§クライアント IP の特定](../spec/features/proxy.md#クライアント-ip-の特定信頼ヘッダーの明示設定132) / [§store の eviction](../spec/features/proxy.md#store-の-evictionメモリ肥大対策132) を参照。

### 制約

- Node.js runtime のインメモリのみ。プロセス再起動でリセットされる。
- 複数 Next.js インスタンスをまたいだ共有は非対応（v2 以降）。

---

## `src/lib/proxy/loopGuard.ts`

**役割**: `enablejs` のような JS 自己再ナビゲーション無限ループを検出する。`rateLimit.ts` と同じインメモリ・スライディングウィンドウ方式だが、キーが異なる。

### データ構造・キー

```ts
// Map<`${ip}\n${host}${pathname}`, タイムスタンプ配列（直近 windowMs 分）>
const store = new Map<string, number[]>();
```

- キーは `IP + ホスト + パス`。**クエリは含めない**（`sei` 等が毎回変わってもループを同一視するため）。
- 既定: ウィンドウ 10 秒 / 閾値 6 回。

### `NavigationLoopGuard`

`check(ip: string, target: URL): boolean` の挙動:

- 現在時刻から `windowMs` 以内のタイムスタンプのみ残し、現在時刻を追記する。
- 残存件数が閾値を超えたら `true`（ループ）を返す。それ以外は `false`。
- レート制限（60 req/分）に達する前に発火するよう、閾値はそれより十分小さく取る（既定 6 回 / 10 秒）。
- **eviction（#132）**: `RateLimiter` と同方式で、`check` 冒頭に `windowMs` ごとに間引いた空エントリ削除を行い、`size` ゲッターを公開する。キーの `ip` 部は `getClientIp` の解決値（未設定時は定数 `"unknown"`）。

`/browse`（GET / POST）は `pageRateLimiter.check` の後にこれを呼び、`true` なら中継 HTML を返さず**自動遷移を含まない静的案内ページ**（HTTP 200）を返してループを停止させる。上限値・誤検知・限界の根拠は [機能仕様 §ナビゲーションループの検出](../spec/features/proxy.md#ナビゲーションループの検出enablejs-対策) を参照。

### 制約

- `rateLimit.ts` と同じくインメモリのみ。プロセス再起動でリセットされ、複数インスタンス間共有は非対応（v2 以降）。

---

## `src/lib/proxy/clientIp.ts`

**役割**: リクエストヘッダーからレート制限・ループ検出のバケットキーに使うクライアント IP を解決する純粋関数 `getClientIp(headers, config?)` と、env から信頼ヘッダー設定を読む `clientIpConfigFromEnv(env?)`（#132）。

- `clientIpConfigFromEnv(env = process.env)`: `PROXY_TRUSTED_IP_HEADER`（小文字化）を `{ trustedHeader: string | null }` として返す純粋関数（`browserFetch.ts` の `*FromEnv` パターンに倣う）。未設定なら `trustedHeader: null`。
- `getClientIp(headers, config = clientIpConfigFromEnv())`: `config.trustedHeader` が設定されていればそのヘッダー値を採用し、未設定・値欠落なら定数 `"unknown"`（fail-safe グローバルバケット）を返す。`x-forwarded-for` 指定時は詐称可能な最左ではなく**最右の値**を採る。クライアント詐称ヘッダーの無条件信頼を避け、バケットキー詐称による全ガード回避を防ぐ（OWASP A04 / CWE-348）。
- `/browse`（`browseGuards`）と `/api/proxy`（`relayAsset`）の両 Route Handler から共通利用する。既定引数で env を解決するため呼び出し側は `getClientIp(req.headers)` のまま。

詳細は [機能仕様 §クライアント IP の特定](../spec/features/proxy.md#クライアント-ip-の特定信頼ヘッダーの明示設定132)。

---

## リバースプロキシ下でのパスプレフィックス

code-server のポート転送（`/proxy/3000/`）など、リバースプロキシがパスプレフィックスを付与する環境向けの設定。

### 環境変数

```bash
# .env.local
NEXT_PUBLIC_BASE_PATH=/proxy/3000
```

### `next.config.mjs` — `assetPrefix`

本番（`next start`）で TypeScript を要求しないよう `.mjs`（型は JSDoc）とする（#87。`.ts` 設定は起動時トランスパイルで `typescript` を必要とし、prune 済み本番イメージで起動失敗するため）。

```js
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
