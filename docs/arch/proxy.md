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
│       ├── rewrite.ts        # HTML / CSS URL 書き換え（SW 登録・GET フォーム横取り（keydown(Enter)・絶対クロスオリジン action 含む。#164）・クリックナビ横取り（history.pushState/replaceState 上書き・Navigation API navigate 横取り含む。#172）・document.domain シム・実行時リクエスト横取りシム（pg() フォールバック含む。#172／動的挿入要素の src 横取り＝buildElementSrcRewrite 含む。#174）<script> 注入含む）
│       ├── proxyPath.ts      # アセット中継 URL スキーム（パス反映）の組み立て・復元（純粋関数。#100）
│       ├── browsePath.ts     # ブラウズ URL スキーム（パス反映）の組み立て・復元（純粋関数。#115）
│       ├── relayAsset.ts     # アセット中継の共通処理（両 route が共有。中継・CORS・OPTIONS）
│       ├── browseRelay.ts    # ブラウズ中継の共通処理（両 route が共有。ティア選択・ループ検出・HTML 書き換え）
│       ├── headers.ts        # レスポンスヘッダー処理・認証ヘッダー転送
│       ├── cookieJar.ts      # サーバー側 Cookie jar（中継 Cookie をクライアントへ返さず origin 別保持・#151 Phase 1）
│       ├── clientIp.ts       # クライアント IP 解決（レート制限のキー）
│       ├── rateLimit.ts      # インメモリ レート制限（ページ/アセット別バケット）
│       ├── targetPolicy.ts   # 中継対象スキーム・ポート制限（オープンプロキシ乱用対策・#133）
│       ├── concurrency.ts    # 同時接続数の制限（グローバル/IP 単位・#133）
│       ├── loopGuard.ts      # ナビゲーションループ検出（enablejs 自己再ナビ対策）
│       ├── promotion.ts      # ヒューリスティック自動ティア昇格（崩れ/チャレンジ検出・再昇格抑止）
│       ├── rbi.ts            # RBI フォールバック判定（第三ティア。設計案＋モック PoC・relayBrowse 未配線・#193）
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
3. browseGuards(req, parsed): pageRateLimiter.check(getClientIp(headers)) → 超過なら 429
3b. isAllowedTarget(parsed, allowedPortsFromEnv()) → スキーム非 http(s)・許可外ポートなら 403
   （[機能仕様 §中継対象スキーム・ポートの制限](../spec/features/proxy.md#中継対象スキームポートの制限133)）
3c. navigationLoopGuard.check(ip, url) → ループ検出なら静的案内ページ(200) を返して打ち切り
   （host+path 単位の短時間連続遷移を検出。[機能仕様 §ナビゲーションループの検出](../spec/features/proxy.md#ナビゲーションループの検出enablejs-対策)）
3d. relayBrowse 入口で relayConcurrencyLimiter.acquire(ip) → グローバル上限超過なら 503・IP 上限超過なら 429。
   取得したスロットはレスポンス構築後に finally で解放（[機能仕様 §同時接続数の制限](../spec/features/proxy.md#同時接続数の制限133)）
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

**自己修復（#201）**: Next.js App Router 等の全体 hydration サイトでは、React が hydration 不一致からのクライアント側再レンダリングで body 直下を作り直す際、注入したバー・スペーサーを `removeChild` で削除する（note.com の react-dom チャンクからの削除をスタックトレースで実測。表示後約 3 秒以内）。対策として注入スクリプトが両ノードの参照を保持し、`document.documentElement` を `MutationObserver`（`childList` + `subtree`。[実行時リクエスト横取りシム注入](#実行時リクエスト横取りシム注入sw-非依存124)のバックストップと同型）で監視して、ノードが document から外れたら保持している同一ノードを現在の `document.body` 先頭へ再挿入し、直後にスペーサー高さをバー実高へ同期する。同一ノード再挿入のため冪等（重複生成なし）で、`input` の値・高さ同期リスナーのクロージャも保持される。`subtree` 監視のため body ごとの差し替えにも追随する。再挿入の回数上限は設けない（React の再レンダリング収束後は削除が止まる。実測で CPU 高止まりなし）。

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
3b. isAllowedTarget(parsed, allowedPortsFromEnv()) → スキーム非 http(s)・許可外ポートなら 403
   （[機能仕様 §中継対象スキーム・ポートの制限](../spec/features/proxy.md#中継対象スキームポートの制限133)）
3c. relayConcurrencyLimiter.acquire(ip) → グローバル上限超過なら 503・IP 上限超過なら 429。
   スロットはレスポンス構築後に finally で解放（[機能仕様 §同時接続数の制限](../spec/features/proxy.md#同時接続数の制限133)）
4. ヘッダー方針をメソッドで分岐:
   - GET/HEAD: forwardableRequestHeaders（許可リスト＝Cookie/Authorization、既存挙動）
   - 非 GET   : relayRequestHeaders（拒否リスト方式で広めに転送）＋ body を転送
   { response, finalUrl } = proxyFetch(url, { method, body, headers }) → SSRF ブロックなら 403
4b. 上流 429 リトライ（GET/HEAD のみ・#166）: res.status === 429 かつ再試行回数が残るなら
   computeRetryWaitMs(res.headers.get("retry-after"), Date.now(), retryConfig) で待機 ms を決定。
   null（Retry-After が上限超）なら 429 を即透過。値が返れば res.body を cancel し sleep 後に
   再 proxyFetch（[機能仕様 §アセット中継の上流 429 リトライ](../spec/features/proxy.md#アセット中継の上流-429-リトライretry-after-尊重166)）
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

> **既知の乖離（#237）**: `connect.lookup` が投げた `SsrfBlockedError` は undici によってプレーンな `Error` へ包み直されるため、`findSsrfCause` の `instanceof` 判定が捕捉できない。結果としてピン留めによる遮断は 403 ではなく **502** で返る。遮断自体は成立しており安全側だが、仕様との乖離として [#237](https://github.com/f8924919/web-proxy/issues/237) で追跡する。

> **ブラウザバック中継の残存制約**: Chromium は接続時に自前再解決するため同様のピン留めができない。`installSsrfGuard` の `context.route` 照合までで、リバインディングの窓は残る（[機能仕様 §SSRF（不弱化）](../spec/features/proxy.md#ssrf不弱化)）。

##### undici のメジャーバージョン制約（7 系固定・#236）

**`undici` は 7 系（`^7.29.0`）に固定する。8 系以降へ上げてはならない。**

この構成は「npm の `undici` が生成した `Agent`」を「**Node 組み込みの `fetch()`**」へ per-request の `dispatcher` として渡している。組み込み `fetch()` の実体は **Node にバンドルされた undici** であり、npm 側の `undici` とは別インスタンスである。両者の dispatcher ハンドラ interface が一致している限りこの受け渡しは成立するが、undici 8 系ではこの interface が刷新され（`onRequestStart` 等）、Node バンドル版と非互換になった。

- 症状: `fetch()` が `TypeError: fetch failed` / cause `invalid onRequestStart method`（`UND_ERR_INVALID_ARG`）を投げ、**プロキシ中継が全経路で 502 になる**
- Node のバージョンが undici 8 の要求（>= 22.19.0）を満たしていても再現する（Node v24.14.1 で確認）。per-request dispatcher 方式そのものが非互換であり、Node 側の互換レイヤ（グローバル dispatcher 向け）では救済されない
- 型検査もモックテストも通過するため、**実際に HTTP スタックを通すテストでしか検出できない**。`tests/lib/proxy/undici-dispatcher.test.ts` にローカル HTTP サーバーを起動する結合テストを置いて回帰を検知する（[テスト方針 §1.1](../testing/policy.md)）
- Dependabot が再度 8 系へ上げる PR を作らないよう `.github/dependabot.yml` で `undici` の major 更新を ignore している
- **解除の条件**: Node 本体のバンドル undici が 8 系に上がり、npm 側 8 系との interface が一致したとき。あるいは `import { fetch } from "undici"` へ切り替えて Agent と fetch を同一インスタンスに揃えたとき（この場合、返る `Response` が global の `Response` ではなくなるため Next のルートハンドラ返却まわりの影響検証が必要）
- **解除すべき時期に気づく手段**: Node 本体のバンドル undici が 8 系に上がると、今度は npm 側 7 系の Agent が逆向きに非互換となり同じ 502 が起きる。`tests/lib/proxy/undici-dispatcher.test.ts` は**この向きの非互換でも red になる**ため、Node 更新時の検知手段としても機能する
- **検討したが採らない代替**: npm `undici` 依存自体を落とし、`assertSsrfAllowed` が解決した IP を URL のホストへ差し替えて接続する案。TLS 証明書検証（SNI）・`Host` ヘッダー・リダイレクト追従の取り回しが複雑になり、#129 の設計判断を覆すことになるため採らない

### エラー型

| エラークラス            | 意味                                                                              |
| ----------------------- | --------------------------------------------------------------------------------- |
| `SsrfBlockedError`      | SSRF ブロック（403 を返す）。ただし `connect.lookup` 由来の遮断は現状 502（#237） |
| `FetchTimeoutError`     | タイムアウト / 到達不能（502 を返す）。原因例外を `cause` に保持（#236）          |
| `TooManyRedirectsError` | リダイレクト追従が上限超過（502 を返す）                                          |
| `BodyTooLargeError`     | 中継本文が上限超過（413 を返す。#134）                                            |

#### 上流 fetch 失敗の丸め込みと可観測性（#236）

`proxyFetch` の catch は、`SsrfBlockedError` 以外の `fetch` 由来の例外をすべて `FetchTimeoutError` に丸める。**丸めるのは呼び出し側のステータス分類を変えないため**であり（`browseRelay` / `relayAsset` はどちらも 502 に収束する）、原因情報を捨てるためではない。エラークラスを細分化しても外形的な振る舞いは変わらないため、分類ではなく `cause` で原因を運ぶ設計を採る。

- `FetchTimeoutError` は `cause` に元の例外を保持する
- `logError` → `formatError`（`src/lib/logger.ts`）が **cause 連鎖を上限付き（5 段）で辿って**出力する。undici の失敗は `TypeError: fetch failed` → `cause: UND_ERR_INVALID_ARG` の多段構造になるため、1 段だけの展開では根本原因が現れない
- `browseRelay` の `FetchTimeoutError` 分岐と `relayAsset` の 502 分岐は `logError` を呼ぶ。ホスト・URL は `maskSensitive` で redact される（[エラーログとプライバシー](../spec/features/proxy.md#エラーログとプライバシー138)）

この設計は #236 の切り分けが困難だった実績（根本原因が応答にもログにも現れなかった）に基づく。運用ログから「タイムアウトと接続不能を区別したい」需要が出た時点で、`UpstreamFetchError` への分割を再検討する。

### 中継本文のサイズ上限（`readTextWithLimit` / `maxBufferBytesFromEnv`・#134）

> 関連仕様: [プロキシ機能仕様 §中継本文のサイズ上限](../spec/features/proxy.md#中継本文のサイズ上限メモリ枯渇-dos-対策134)

書き換えのため全量バッファする HTML / CSS の本文に上限を設ける純粋関数群。

- `maxBufferBytesFromEnv(env = process.env)`: `PROXY_MAX_BUFFER_BYTES` を整数として読み、正の整数以外・未設定なら既定 `10 * 1024 * 1024`（10 MiB）を返す（`*FromEnv` パターン）。
- `readTextWithLimit(res, maxBytes)`: `res.text()` の代替。①`Content-Length` が `maxBytes` 超過を宣言していれば読む前に `BodyTooLargeError` を投げる。②`res.body`（Web Streams `ReadableStream<Uint8Array>`）を `getReader()` でチャンク読みし、累積バイト数が `maxBytes` を超えたらストリームを `cancel` して `BodyTooLargeError` を投げる。上限内なら `resolveCharset` で判定した文字コードでデコードした文字列を返す（`res.body` が無ければ空文字）。**サイズ上限の累積判定はデコード前の生バイト列で行う**ため、文字コード追従後も `413` 挙動は不変。
- `resolveCharset(contentType, bytes)`: 中継本文の文字コードを判定する純粋関数（#158）。①`Content-Type` の `charset=` → ②（①が無い場合）`bytes` 先頭の sniff（HTML `<meta charset>` / `<meta http-equiv>`、CSS `@charset`）→ ③ UTF-8、の優先順でラベルを決める。`readTextWithLimit` は判定ラベルで `TextDecoder` を生成し、未知・不正ラベルなら UTF-8 にフォールバックする（`euc-jp` / `shift_jis` / `iso-2022-jp` は Node 組込みで対応。追加依存なし）。仕様: [§中継本文の文字コード処理](../spec/features/proxy.md#中継本文の文字コード処理158)。

`relayBrowse`（HTML）・`relayAsset`（CSS）はこれを用いて読み、`BodyTooLargeError` を捕捉して `413` を返す。書き換え後の本文は常に UTF-8（`charset=utf-8`）で返す。書き換え不要アセットは `res.body` ストリーム透過のため対象外。

ブラウザティア（`browserFetch`）は `page.content()` で DOM 全体を Node ヒープへ展開した後でしか `readTextWithLimit` が効かないため、`browserFetch` 側で `page.content()` の**前**に DOM サイズを概算して同じ上限で打ち切る（[§browserFetch.ts](#srclibproxybrowserfetchts) の `measureDomByteLength` / `domSizeExceedsLimit`・#144）。`browserFetch` が投げる `BodyTooLargeError` は `relayBrowse` の `fetchTarget` で（`SsrfBlockedError` と同様に）フォールバックさせず伝播させ、`413` へ揃える。

---

## `src/lib/proxy/browserFetch.ts`

> 関連仕様: [プロキシ機能仕様 §ブラウザバック中継](../spec/features/proxy.md#ブラウザバック中継browser-backed-fetch)

**役割**: 特定サイトの `/browse` GET について、初回ナビゲーションをヘッドレスブラウザ（インプロセス Playwright）で実行し、JS 解決後の DOM を `proxyFetch` と同じ `{ response, finalUrl }` 契約で返す。あわせてブラウザが取得した Cookie を `Set-Cookie` 化して返し、呼び出し側が jar へ取り込む（セッションウォーミング）。

### ティア判定（純粋関数）

| 純粋関数                        | 役割                                                                                                                                                 |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `parseBrowserHosts(raw)`        | `PROXY_BROWSER_HOSTS`（カンマ区切り）を正規化したホスト接尾辞配列にする                                                                              |
| `browserTierConfigFromEnv(env)` | `PROXY_BROWSER_MODE` / `PROXY_BROWSER_HOSTS` から `{ mode, hosts }` を組み立てる。MODE 未設定・不正値時は HOSTS が非空なら `allowlist`、空なら `off` |
| `shouldUseBrowser(url, config)` | URL とコンフィグからブラウザティアを使うか判定。`off`→常に false、`on`→常に true、`allowlist`→ホスト接尾辞一致時のみ true。URL 不正は false          |

- ホスト一致は接尾辞方式: `example.com` は `example.com` と `*.example.com` に一致する（`host === suffix || host.endsWith("." + suffix)`）。
- env 未設定時は `off` 相当で**常に中継ティア**（既定挙動の回帰なし）。

### 待機・Cookie 変換（純粋関数）

| 純粋関数                        | 役割                                                                                                                                                                                                            |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `resolveBrowserWaitConfig(env)` | `PROXY_BROWSER_WAIT_UNTIL` / `PROXY_BROWSER_TIMEOUT_MS` / `PROXY_BROWSER_SETTLE_MS` を検証して `{ waitUntil, timeoutMs, settleMs }` を返す（不正値は既定へフォールバック。`debug-browser.mjs` と同方針、#39）   |
| `cookieToSetCookie(cookie)`     | Playwright の cookie オブジェクトを `Set-Cookie` 文字列へ変換する。`Domain` は付けず（`cookieJar.store` が origin 別に保持）、`Path` / `Secure` / `HttpOnly` / `SameSite` / 永続 cookie の `Expires` を反映する |

### CSSOM スタイルの実体化（DOM 操作関数・#120）

> 関連仕様: [プロキシ機能仕様 §browserFetch の振る舞い](../spec/features/proxy.md#browserfetch-の振る舞い)。対応 Issue: [#120](https://github.com/f8924919/web-proxy/issues/120)。

`page.content()` は DOM テキストのみをシリアライズし、CSSOM（`insertRule`）注入の CSS や `adoptedStyleSheets` を出力しない。CSS-in-JS サイト（例 news.yahoo.co.jp）はクライアントで CSS を CSSOM に直接注入し `<style>` を空にするため、取得 DOM から CSS が欠落しレイアウトが崩れる。これを防ぐため、`page.content()` の直前に DOM を実体化する。

| 関数                     | 役割                                                                                                                                                                                                                                                                                                                     |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `inlineCssomStyles(doc)` | 各 `<style>` の `sheet.cssRules` を結合して `<style>` テキストへ書き戻す（テキストが CSSOM ルールより短い場合のみ＝冪等）。`doc.adoptedStyleSheets` の各シートのルールを `<style data-proxy-adopted>` として `<head>` へ出力する。`cssRules` を読めないシート（cross-origin 等）は例外を握り潰してスキップし全損させない |

- **配線**: `browserFetch` で `page.content()` を呼ぶ直前に `page.evaluate(inlineCssomStyles)` を実行する。`inlineCssomStyles` は外部参照を持たず DOM グローバルのみで完結させる（`page.evaluate` がブラウザ context で実行するため。`doc` 引数の既定値はブラウザの `document`）。ブラウザティアでは常時実行（env フラグなし）。
- **テスト**: `inlineCssomStyles` を `document` 互換オブジェクトに対する単体テストで検証する。`page.evaluate` の I/O 配線は[テスト方針](../testing/policy.md)によりテスト対象外。

### 描画済み DOM のサイズ上限（DOM 概算関数・#144）

> 関連仕様: [プロキシ機能仕様 §browserFetch の振る舞い](../spec/features/proxy.md#browserfetch-の振る舞い) / [§中継本文のサイズ上限](../spec/features/proxy.md#中継本文のサイズ上限メモリ枯渇-dos-対策134)。対応 Issue: [#144](https://github.com/f8924919/web-proxy/issues/144)。

`readTextWithLimit`（#134）は `proxyFetch` のストリーム本文にしか効かず、`browserFetch` は `page.content()` で描画済み DOM を文字列化した時点で Node ヒープへ全量展開されるため上限検査が「手遅れ」になる。これを防ぐため `page.content()` の**前**に DOM サイズを概算して同じ上限で打ち切る。

| 関数 / 役割                                 | 役割                                                                                                                                                                                                                                                                                       |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `measureDomByteLength(doc?)`                | ブラウザ context 内で `doc.documentElement.outerHTML` の UTF-8 バイト数（`new TextEncoder().encode(...).length`）を返す。`page.evaluate` で実行するため `doc` 既定値はブラウザの `document`。バイト基準で #134 の上限と揃える（文字列長＝UTF-16 単位数だとマルチバイトを過小評価するため） |
| `domSizeExceedsLimit(byteLength, maxBytes)` | 概算バイト数が上限を超えるか判定する純粋関数。`readTextWithLimit` と同じく **`>`（厳密超過）** で判定する                                                                                                                                                                                  |

- **配線**: `browserFetch` で `inlineCssomStyles` 実体化の後・`page.content()` の直前に `page.evaluate(measureDomByteLength)` で概算し、`domSizeExceedsLimit(byteLength, maxBufferBytesFromEnv())` が真なら `page.content()` を呼ばずに `BodyTooLargeError` を投げる。測定 evaluate が失敗した場合は概算 0（上限内）として続行し、後段の `readTextWithLimit` を安全網に残す（ベストエフォート方針は `inlineCssomStyles` と同じ）。
- **伝播**: `fetchTarget`（`browseRelay.ts`）は `browserFetch` の `BodyTooLargeError` を `SsrfBlockedError` 同様にフォールバックさせず再 throw し、`relayBrowse` の取得時 `catch` が `413` を返す（展開後経路の 413 とメッセージ・ステータスを揃える）。
- **テスト**: `measureDomByteLength`（`document` 互換オブジェクト・マルチバイト）と `domSizeExceedsLimit`（境界値）を単体テスト対象とする。`page.evaluate` の I/O 配線は[テスト方針](../testing/policy.md)によりテスト対象外。

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
- **取得**: `page.goto`（`resolveBrowserWaitConfig` の待機）→ settle 待ち → `inlineCssomStyles` 実体化 → **DOM サイズ概算（`measureDomByteLength`）で上限超過なら打ち切り（#144）** → `page.content()`（本文）/ `page.url()`（finalUrl）。失敗時もベストエフォートで収集して返す。
- **Cookie ウォーミング**: `context.cookies()` を `cookieToSetCookie` で `Set-Cookie` 化し、`text/html` の `Response` ヘッダーへ載せる。以降は `relayBrowse` がこれを `cookieJar.store(...)` で jar へ取り込む（ブラウザへは返さない）。
- **ライフサイクル**: ブラウザはプロセス内で再利用し、context はリクエストごとに作って確実に close する。同時実行数を上限（`PROXY_BROWSER_MAX_CONCURRENCY`、既定 2）で絞る。
- **テスト**: 純粋関数（上記）のみ単体テスト対象。ブラウザ I/O は[テスト方針](../testing/policy.md)によりテスト対象外。
- **既知の制約（#123）**: 配信する `page.content()` は hydration 後の DOM のため、クライアントの再 hydration で React の hydration エラー（`#418` 等）が console に多発する。実害なし（コンソールノイズ）と切り分け済みで、低減策は体験を壊すリスクから意図的に見送る。詳細は[機能仕様 §既知の制約: クライアント再 hydration](../spec/features/proxy.md#既知の制約-クライアント再-hydration123)。

---

## `src/lib/proxy/promotion.ts`

> 関連仕様: [プロキシ機能仕様 §ヒューリスティック自動ティア昇格](../spec/features/proxy.md#ヒューリスティック自動ティア昇格崩れチャレンジ検出)。対応 Issue: [#70](https://github.com/f8924919/web-proxy/issues/70)。

**役割**: 中継ティア（`proxyFetch`）の初回応答から「崩れ / チャレンジ」を検出し、ブラウザティアへ自動昇格すべきかを判定する。明示 allowlist（`shouldUseBrowser`）を**補助**するヒューリスティックで、`browserFetch.ts` のティア判定とは独立したモジュールに切り出す。

### 昇格判定・有効化（純粋関数）

| 純粋関数                                            | 役割                                                                                                                                                                                       |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `autoPromoteEnabledFromEnv(env)`                    | `PROXY_BROWSER_AUTO_PROMOTE`（`true` / `1` / `on` で有効、既定無効）を解釈する                                                                                                             |
| `shouldPromoteToBrowser(html, status, contentType)` | `text/html` 応答について、チャレンジ語句 / `<noscript>` 主体 / `403`・`503` / 空 SPA シェル（#160）のいずれかを検出したら `true`。非 HTML は常に `false`（空 body 単独は判定材料にしない） |

- **チャレンジ語句**: `enable javascript` / `enablejs` / `checking your browser` / `recaptcha` / Cloudflare チャレンジ等の語句を本文（小文字化）に含むか判定する。
- **`<noscript>` 主体**: `<noscript>` を含み、かつ `<script>` / `<style>` / `<noscript>` を除いた可視テキストが極小であるかで判定する。
- **除去用正規表現の終了タグ（#246）**: 可視テキスト抽出（`visibleTextOutsideNoscript`）で `<script>` / `<style>` / `<noscript>` を内容ごと除去する際、終了タグは `</script(?:\s[^>]*)?>` 形式で照合し、**`>` 直前の空白・改行**（`</script >` / `</script\n>`・HTML 仕様上正当）と**属性付き終了タグ**（`</script bar>`・HTML5 ではパースエラーだがブラウザは属性を無視して終了タグ扱いする）の双方を許容する。固定文字列 `</script>` だけで照合すると除去に失敗し、要素の中身が可視テキストとして数えられて昇格が検出漏れする（開始タグ側の `<noscript[\s>]` と対称にする）。**タグ名の直後には空白か `>` を要求する**のが要点で、これにより `</scriptfoo>` のような別トークンを終了タグと誤認しない（`</script[^>]*>` まで緩めると誤認する）。CodeQL `js/bad-tag-filter` はこの 2 形態の両方に追従して初めて解消する。
- **空 SPA シェル（#160）**: ① 既知の SPA マウント先要素の存在（`SPA_ROOT_IDS` = `root` / `__next` / `app` / `app-root`・タグ種別不問・ID 完全一致は id 値直後の引用符/空白/`>` を先読み `(?=[\s>])` で担保）② 外部 `<script src>` の存在（`src` は独立属性として照合し `data-src` 等を弾く）③ 可視テキスト極小、の **3 条件 AND** で判定する。クライアント描画 SPA（中継ティアでは `location.pathname` がプロキシパスになり描画されない）を昇格対象にする。`node-html-parser` は使わず `promotion.ts` 既存の正規表現方針に揃える。

### 再昇格抑止（`PromotionGuard`・インメモリ状態）

- 同一 URL（`ホスト + パス` 単位・**クエリ無視**）を短時間ウィンドウ内で一度昇格したら再昇格しないことで、`proxyFetch` → `browserFetch` の二重取得を URL あたり高々 1 回 / ウィンドウに制限する。
- `loopGuard.ts` / `rateLimit.ts` と同じ `Map<key, timestamps[]>` のスライディングウィンドウ方式（既定ウィンドウ 60 秒、プロセス再起動でリセット）。
- 共有インスタンス `promotionGuard` を `route.ts` が利用する。`tryPromote(target)` は再昇格可なら記録して `true`、抑止中なら `false` を返す。
- **テスト**: 純粋関数（`autoPromoteEnabledFromEnv` / `shouldPromoteToBrowser`）と `PromotionGuard` のウィンドウ挙動を単体テスト対象とする（[テスト方針](../testing/policy.md)）。`browserFetch` 本体（I/O）はテスト対象外。

---

## `src/lib/proxy/rbi.ts`（設計案・#193。実装はモック PoC のみ）

> 対応 Issue: [#193](https://github.com/f8924919/web-proxy/issues/193)（調査スパイク）。検討経緯・PoC 実測は [docs/task/193-rbi-selfhost-poc.md](../task/193-rbi-selfhost-poc.md)。**relayBrowse への配線・実バックエンド（Kasm / Neko）・spec 反映は本採用タスクで行う（本節は設計の正本、現時点の実装はモックバックエンドと判定純粋関数まで）。**

**役割**: 書き換え方式でも headless ブラウザティアでも成立しないサイトを、RBI（Remote Browser Isolation。Kasm / Neko の対話ストリーム）へフォールバックさせる**第三ティア**の判定。中継（`proxyFetch`）→ ブラウザ（`browserFetch`）→ RBI の三層エスカレーションの最上段にあたる。

### 契約の決定（`{response, finalUrl}` には載せない）

RBI は「1 リクエスト = 1 文書」ではなく「セッション確立 + 継続ストリーム（WebRTC / VNC）」のモデルのため、`browserFetch` のインターフェース契約（`(url, options?) => {response, finalUrl}`）には**載せない**。代わりに**セッション仲介契約**を新設する:

```ts
interface RbiBackend {
  createSession(
    targetUrl: string,
    seedCookies?: CookieSeed[]
  ): Promise<{ sessionId: string; sessionUrl: string }>;
  destroySession(sessionId: string): Promise<void>;
}
```

- RBI 経路が選ばれた場合、`relayBrowse` は本文の取得・書き換えを行わず、`createSession` が返す `sessionUrl` へユーザーを誘導する。以降のユーザー操作はブラウザと RBI バックエンド間の直接ストリームであり、本プロキシの書き換えパイプラインは関与しない。
- したがって `rewrite.ts` のスクリプト注入群・`sw.js` の横取りは RBI 経路では**丸ごと不要**（[#72 §5](../task/archive/72-rbi-isolation-spike.md) の「書き換え方式は RBI 非対象サイト向けの軽量フォールバックへ降格」の実現形）。
- `seedCookies` は cookieJar のログイン状態を RBI セッションへ引き継ぐ**将来拡張の余地**（PoC・初期採用では未実装）。現状は RBI セッションは jar の状態を持たず**コールドスタート**し、RBI 内で確立した Cookie も jar へ戻らない（既知の制約。#73 の主シグナル＝egress IP 起因ブロックは Cookie 非依存のため初期は許容）。

### 誘導方式の比較（決定: PoC は 302、本採用第一候補は iframe 埋め込み）

| 方式            | 利点                                                                          | 欠点                                                                                                                 |
| --------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| 302 直誘導      | 最も単純・疎結合                                                              | プロキシのコンテキスト（アドレスバー UI・`__pxy_auth` 認証境界）から完全離脱。`RBI_BASE_URL` オリジンの生 URL が露出 |
| iframe 埋め込み | プロキシの UI・認証境界を保持し体験が一貫（Hyperbeam の埋め込みモデルと同型） | RBI 側の `CSP frame-ancestors` 許可が必要（Kasm / Neko は自前ホストのため制御可能）。実装コスト増                    |
| 誘導ページ      | 明示遷移のワンクッション（上記の中間）                                        | 1 クリック増える                                                                                                     |

- **PoC は最小の 302** で契約を検証し、**本採用時は iframe 埋め込みを第一候補**として再評価する（2026-07-05 ユーザー確認済み）。契約（`createSession` → `sessionUrl`）は誘導方式に依存しないため、この差し替えで `RbiBackend` は変わらない。

### セキュリティ要件

- **SSRF**: RBI 経路は中継・ブラウザティアをスキップするため、そのままでは `assertSsrfAllowed` を一度も通らない。**`createSession` 前に `assertSsrfAllowed(targetUrl)` を必須**とし、RBI が SSRF 踏み台になる穴を塞ぐ（2026-07-05 ユーザー確認済み）。ただし実際のナビゲーションは RBI 側 Chromium が再解決するため IP ピン留めは効かず、`browserFetch` と同様のリバインディング残存窓がある（既知の制約）。
- **sessionUrl はケーパビリティ URL**: 302 の `Location`（履歴・`Referer` に残る）に載るため、推測不能な ID・TTL 束縛（可能なら初回接続で失効する単回バインド）を要件とする。`sessionUrl` のオリジンは `RBI_BASE_URL` に一致することを検証する（オープンリダイレクト防止）。
- **認証境界**: `PROXY_AUTH_TOKEN` 有効時、302 誘導はユーザーを認証ゲート外（RBI バックエンド）へ出す。RBI 側認証との橋渡しは本採用時の検討事項。

### 判定（純粋関数・既存 2 関数の再利用）

| 純粋関数 / 定数              | 役割                                                                                                                                                                                                                            |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rbiBackendFromEnv(env)`     | `RBI_BACKEND`（`off` / `mock` / `kasm` / `neko`、既定 `off`）と `RBI_BASE_URL` から設定を組み立てる。`off` なら RBI 判定全体を無効化                                                                                            |
| `shouldUseRbi(url, config)`  | allowlist 方式（`RBI_FORCE_HOSTS`、`shouldUseBrowser` と同型のホスト照合）。明示指定サイトは最初から RBI へ                                                                                                                     |
| `shouldPromoteToRbi(result)` | **ブラウザティアの出力**に `shouldPromoteToBrowser(html, status, contentType)` を再適用し、真（= ブラウザ昇格後もチャレンジ / 崩れが解消しない）なら RBI 昇格候補とする（判定ロジック新設なし・既存ヒューリスティックの再利用） |

- **#73 との接合点**: 「ブラウザティアでもチャレンジが解消しない」は egress IP 起因ブロックの主シグナルであり、residential egress を持つ RBI バックエンドへ振り向ける判断材料になる。egress の手配・検出の高度化（IP 品質分類等）は #73 の領域とし、本設計はこのシグナル 1 本で接合する。

### 再昇格抑止（`RbiGuard`）・セッション上限（`RbiSessionLimiter`）・インメモリ状態

- **`RbiGuard`**: `PromotionGuard` と同型のスライディングウィンドウ（`ホスト + パス` 単位）で再昇格を抑止する。責務はウィンドウ抑止のみに絞る。
- **`RbiSessionLimiter`**: 同時セッション数上限（`RBI_MAX_SESSIONS`）は増減する生カウンタのため、ウィンドウ方式と混ぜず `ConcurrencyLimiter` と同型の `acquire(): release` として分離する。TTL（`RBI_SESSION_TTL_MS`）失効・`destroySession` 時に release と対応づける（セッションリーク防止。TTL 失効時に `destroySession` を呼ぶ掃除役の配線は本採用時の設計事項）。
- **既知の制約**: いずれもインメモリ前提のため複数インスタンス構成では上限を共有できない。本採用時に複数インスタンスへ広げる場合は共有ストア（DB / Redis 等）が必要（本 PoC では単一インスタンス前提と明記して見送り）。

### 配線案（本採用時。PoC では実装しない）

1. `relayBrowse` 冒頭: `shouldUseRbi(url)` が真なら `assertSsrfAllowed` → `createSession` → 誘導（中継・ブラウザティアをスキップ）。**この経路の `createSession` 失敗時は通常のティア選択へフォールスルー**する（まだ何も取得していないため）。
2. ブラウザティア応答後: `shouldPromoteToRbi(result)` かつ `rbiGuard.tryPromote(target)` が真なら `assertSsrfAllowed` → `createSession` → 誘導。**この経路の失敗時は取得済みのブラウザティア結果をそのまま返す**（RBI はベストエフォートの改善であり可用性を下げない）。
3. **前提の明記**: RBI 自動昇格（手順 2）はブラウザティアの実行が前提。ブラウザティアが走らないサイト（allowlist 外かつ自動昇格 off）では `RBI_FORCE_HOSTS` 指定以外で RBI へ到達しない（段階エスカレーションの意図どおり）。
4. **本採用時の検討事項**: `relayConcurrencyLimiter`（誘導応答で即解放）と `RbiSessionLimiter`（セッション生存中保持）はライフサイクルが異なる別カウンタになる点の整理。

### 環境変数（案）

| 変数                 | 意味                                                                                                                                               | 既定  |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| `RBI_BACKEND`        | `off` / `mock` / `kasm` / `neko`                                                                                                                   | `off` |
| `RBI_BASE_URL`       | RBI バックエンドの URL（セッション URL の生成元・オリジン検証の基準）                                                                              | なし  |
| `RBI_FORCE_HOSTS`    | 最初から RBI へ送るホストの allowlist（カンマ区切り）                                                                                              | 空    |
| `RBI_MAX_SESSIONS`   | 同時セッション数上限。既定 `5` は安全側の据え置き（フェーズ2 実測 約 0.9 コア / 0.9GB / 3Mbps per セッションを根拠にホスト資源に合わせて調整する） | `5`   |
| `RBI_SESSION_TTL_MS` | セッションの生存時間                                                                                                                               | 15 分 |

- **テスト**: 純粋関数（`rbiBackendFromEnv` / `shouldUseRbi` / `shouldPromoteToRbi`）と `RbiGuard`（ウィンドウ）・`RbiSessionLimiter`（上限・release 冪等）、`MockRbiBackend`（`RBI_BASE_URL` オリジンの推測不能な `sessionUrl` を返す PoC 用実装）を単体テスト対象とする（[テスト方針](../testing/policy.md)）。実バックエンドへの接続 I/O はテスト対象外。

---

## `src/lib/proxy/rewrite.ts`

**役割**: HTML / CSS の URL を書き換える。

### HTML 書き換え（`node-html-parser` 使用）

相対 URL は `baseUrl` を基準に絶対 URL へ変換してからエンコードする。

| 対象                               | 書き換え先                                                                                                                                                                                                                                                                                               |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<a href>`                         | `/browse/<scheme>/<host>/<path>`                                                                                                                                                                                                                                                                         |
| `<form action>`                    | `/browse/<scheme>/<host>/<path>`                                                                                                                                                                                                                                                                         |
| `<iframe src>`                     | `/browse/<scheme>/<host>/<path>`（#135）                                                                                                                                                                                                                                                                 |
| `<img src>` / `<source src>`       | `/api/proxy/<scheme>/<host>/<path>`                                                                                                                                                                                                                                                                      |
| `<video src>` / `<audio src>`      | `/api/proxy/<scheme>/<host>/<path>`（#135）                                                                                                                                                                                                                                                              |
| `<video poster>`                   | `/api/proxy/<scheme>/<host>/<path>`（#183）                                                                                                                                                                                                                                                              |
| `<img srcset>` / `<source srcset>` | 各候補 URL を `/api/proxy/<scheme>/<host>/<path>`（記述子保持）                                                                                                                                                                                                                                          |
| `<link href>`                      | rel 別: 書き換え系 rel（stylesheet/preload 系・icon 系/manifest）は `/api/proxy/<scheme>/<host>/<path>`、接続ヒント系（preconnect/dns-prefetch/compression-dictionary）は要素ごと削除、情報系は維持（#189。[機能仕様 §`<link>` の rel 別取り扱い](../spec/features/proxy.md#link-の-rel-別取り扱い189)） |
| `<script src>`                     | `/api/proxy/<scheme>/<host>/<path>`                                                                                                                                                                                                                                                                      |
| `<meta http-equiv=refresh>`        | `/browse/<scheme>/<host>/<path>`                                                                                                                                                                                                                                                                         |
| `<base href>`                      | 解決基点へ取り込み後に `href` を除去（#135）                                                                                                                                                                                                                                                             |
| インライン `<style>` のテキスト    | `rewriteCss` を適用（`url()` / `@import` を `/api/proxy` へ・#185）                                                                                                                                                                                                                                      |

> アセット系（`<img>`/`<link>`/`<script>`/`srcset`/CSS）は `assetUrl()` → `proxyPath.ts` の `buildProxyPath()`（`/api/proxy/...`・#100）、ナビゲーション系（`<a>`/`<form>`/meta refresh）は `browseUrl()` → `browsePath.ts` の `buildBrowsePath()`（`/browse/...`・#115）でパス反映形式に組み立てる（[機能仕様 §プロキシ URL スキーム](../spec/features/proxy.md#プロキシ-url-スキームパス反映)）。両者は同形のスキームで、`%2F`/非 ASCII の percent-encoding を保持する（#111）。

`<meta http-equiv="refresh" content="<遅延>;url=<TARGET>">` は `content` 内の `url=` を正規表現で抜き出し、`<a href>` と同じ `browseUrl()` で書き換える（遅延値は保持）。ルート相対 `url` がプロキシオリジン直下へ解決されて離脱するのを防ぐ。`<noscript>` 内の meta refresh はパーサが生テキスト扱いするため対象外（[機能仕様 §meta refresh の書き換え](../spec/features/proxy.md#meta-refresh-の書き換え)の制限）。

`<img>` / `<source>` の `srcset` は純粋関数 `rewriteSrcset(value, baseUrl)` で各候補に分解し、URL 部のみ `assetUrl()` で書き換え記述子を保持して再結合する。WHATWG srcset 解析に準じ URL 部を空白以外の連続文字として取り出すため `data:` URL 内のカンマで誤分割しない（[機能仕様 §srcset の書き換え](../spec/features/proxy.md#srcset-の書き換え)）。Next.js 製サイトの `<Image>` が出力する `/_next/image?url=…` をプロキシ origin 直下の最適化エンドポイントへ解決させず（400 回避）、上流の最適化 URL を中継する（#98）。

`src` を書き換える `<script>`、および `href` を書き換える resource rel の `<link>` からは `integrity` / `crossorigin` 属性を除去する（#188）。書換後は `/api/proxy` 経由の中継レスポンスとなり SRI ハッシュが一致せずブロックされるため（[機能仕様 §SRI 属性の除去](../spec/features/proxy.md#サブリソース整合性sri属性の除去)）。あわせて inline の `<meta http-equiv="Content-Security-Policy">`（enforce のみ。`...-Report-Only` は残す）を除去し、注入スクリプト・書換 src が CSP でブロックされるのを防ぐ（[機能仕様 §inline CSP（meta）の除去](../spec/features/proxy.md#inline-cspmetaの除去)）。

`<base href>` は書き換えの最初に処理する。文書内の最初の `<base href>` を `baseUrl` 基準で解決し、http(s) に解決できればそれを以降の全書き換えの実効解決基点（`effectiveBase`）として用いてから、すべての `<base>` 要素の `href` を除去する。残すと取りこぼし属性・実行時生成の相対 URL がブラウザによって `<base href>` 基準で解決され、プロキシ枠を外れた実サイト直アクセスを誘発し得るため（注入シムは `location.href` 基準で `<base>` を参照しない。[機能仕様 §`<base href>` の処理](../spec/features/proxy.md#base-href-の処理枠外離脱防止135)）。`<iframe src>` は `<a href>` と同じ `browseUrl()`（埋め込みページもブラウズ画面で開く）、`<video src>` / `<audio src>`・`<video poster>` は `<img src>` と同じ `assetUrl()` で書き換える（#135・#183）。

### CSS 書き換え

正規表現で `url(...)` と `@import` を `assetUrl()`（パス反映形式 `/api/proxy/<scheme>/<host>/<path>`）へ置換。

`rewriteCss` は fetch した `text/css`（`relayAsset`）に加え、`rewriteHtml` がインライン `<style>` 要素のテキストにも適用する（#185）。未書き換えだと絶対 / プロトコル相対の `url()` が初回ロードの SW ギャップ中に素の URL へ直接ロード＝離脱する（実測: en.wikipedia.org の外部リンクアイコン）。テキストの差し替えは `node-html-parser` のテキストノード置換で行い、CSS 中の `<` 等を HTML として再解釈させない。`style` 属性・CSSOM 動的操作は対象外（[機能仕様 §CSS URL 書き換え](../spec/features/proxy.md#css-url-書き換え)の既知の制限）。

### アドレスバー注入

`rewriteHtml` は URL 書き換えに加え、アドレスバー HTML スニペットを `<body>` 直後に注入する。バーは `position: fixed`、直後のスペーサー `#proxy-addressbar-spacer` の高さをバー実高へ同期してコンテンツの重なりを防ぐ（#108）。スニペット末尾の IIFE スクリプトが高さ同期に加え、全体 hydration サイトによるノード削除からの自己修復（同一ノード再挿入・#201）を担う（詳細は前段の[アドレスバー注入](#アドレスバー注入)を参照）。

注入スニペット `ADDRESS_BAR_HTML` は最終 URL（`currentUrl`）を `<input value="…">` へ埋め込む。この値は汎用関数 `escapeHtml`（`rewrite.ts`）で `& < > " '` を一括して HTML 実体参照へエスケープしてから差し込む。`currentUrl` は `new URL` 正規化済みで属性ブレイクアウト自体は塞がれているが、`&`（クエリ区切り）や `< > '` は URL 文法上そのまま含まれ得るため、出力エンコードの欠落による XSS（CWE-116）を防ぐ目的で一括エスケープを行う（#137）。

### GET フォーム送信横取りスクリプト注入

> 関連仕様: [プロキシ機能仕様 §GET フォーム送信の横取り](../spec/features/proxy.md#get-フォーム送信の横取り)

`rewriteHtml` は `<body>` 直後（アドレスバー・SW 登録に続けて）に、GET フォーム送信を横取りする `<script>` を注入する。パス反映ナビ形式（#115）では `action` がターゲットを**パス部**に持つため GET 送信でも消失しないが、SPA（React 等）が自前 submit ハンドラで実サイトへ後勝ち遷移する（#93）のを阻止するため横取りは維持する。

注入スクリプトは 3 経路で捕捉する。いずれも振り向け先の決定は純粋関数 `buildGetFormDestination`（＋共有ヘルパー `extractBrowseTarget` / `browseNavPrefix` / `buildBrowseDest`）を共用する。

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

(C) document に keydown を capture で委任（Enter キー。#164）:
- submit イベントも form.submit() も介さず、自前の keydown ハンドラで location.href へ
  実サイト絶対 URL を直接代入して遷移するサイト（例 www.yahoo.co.jp トップ検索）対策。
  location 系は改変不能のためフックできず、(A)(B) は空振りする。
- Enter 押下が「フォーム内 input の暗黙送信」相当のときのみ、サイトの keydown ハンドラより
  先に preventDefault + stopImmediatePropagation し、同じ buildGetFormDestination で遷移する。
- 誤捕捉回避: IME 変換中（isComposing / keyCode 229）・修飾キー併用は素通し。textarea や
  送信を伴わない input 型（button/submit/reset/checkbox/radio/file/image）・フォーム外 input・
  アドレスバーは対象外。dest が null なら preventDefault せず素通し（挙動を変えない）。
```

`buildGetFormDestination` は、`action` がパス反映／後方互換いずれの proxy ナビ URL でもなく、かつ閲覧ページ（プロキシ）と**別オリジンの絶対 http(s) URL**（ハイドレーションで実サイト URL へ復元された action 等。#164）のときは、その URL 自体を実ターゲットとして直接 proxify する。プレフィックスは閲覧ページ URL から導出する。

`BASE_PATH` とパス反映プレフィックスは `action`/`window.location` から再利用することで保持される（スクリプト内で BASE_PATH を個別に組み立てない）。フォーム要素と無関係な `location.assign` / `history` 駆動の純粋な JS ナビゲーションは対象外。

### クライアント側ナビゲーション横取りスクリプト注入

> 関連仕様: [プロキシ機能仕様 §クライアント側ナビゲーションの横取り](../spec/features/proxy.md#クライアント側ナビゲーションの横取り)

`rewriteHtml` は `<body>` 直後（GET フォーム横取りに続けて）に、`<a>` クリックによるナビゲーションを横取りする `<script>`（`CLICK_NAV_INTERCEPT_HTML`）を注入する。サーバー側 `<a href>` 書き換えは初期 HTML を一度書き換えるだけで、(1) JS が動的描画したリンク（生の絶対/相対 URL）は対象外、(2) SPA（React 等）が `<a>` クリックを onClick ルーターで奪い `history.pushState` で遷移する、のいずれでも実サイトへ離脱するため、それを補う（#82）。`location` API はブラウザ仕様で改変不能（[機能仕様 §クライアント側ナビゲーションの横取り](../spec/features/proxy.md#クライアント側ナビゲーションの横取り)）なので、`<a>` クリックはフックではなく**クリックの主導権を奪う**方式を採る。一方 `history.pushState` / `history.replaceState` は `History.prototype` のメソッドで上書き可能なため、**同じ注入スクリプト内で両メソッドを上書き**して URL を書き換える（#172。下記）。

振り向け先 URL の決定は純粋関数 **`buildClickNavDestination(href, pageUrl)`** に分離し、`GET_FORM_INTERCEPT_HTML` と同様 `toString()` で `<script>` に埋め込む（外部参照を持たず `URL` のみで完結）。同スクリプトは history（`buildClickNavDestination` 再利用）・Navigation API（純粋関数 **`buildNavApiRedirect(destUrl, pageUrl)`**）の横取りも担う（#172。下記）。

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

同じ <script> 内で history.pushState / replaceState も上書き（#172。同関数 build= buildClickNavDestination を再利用）:
  function wrap(orig){ return function(state,title,url){
    url != null のとき: dest = build(String(url), location.href);
      dest あり → orig.call(this, state, title, dest)（パス反映ナビ形式へ書き換えて委譲）
    それ以外（url 省略・# アンカー・非 http・復元不能）→ orig.apply(this, arguments)（素通し）
  }}
  history.pushState / history.replaceState が在れば各々 wrap で置換（無い環境は据え置き）

同じ <script> 内で Navigation API（window.navigation）の navigate イベントも横取り（#172。純粋関数 buildNavApiRedirect 再利用）:
  navigation.addEventListener('navigate', e => {
    userInitiated / hashChange / downloadRequest / formData / !canIntercept / !cancelable → 介入しない
    dest = buildNavApiRedirect(e.destination.url, location.href)（クロスオリジン・枠保持・自前資産は null）
    dest かつ dest !== 現在地(path+search+hash)（=別ページ）→ e.preventDefault(); location.href = dest
    dest が現在地と同一（自己遷移）→ 介入しない（preventDefault はサイトの e.intercept() 描画も
      巻き込むため。離脱はリクエストシムの pg() フォールバックが担保）
  })  // window.navigation 非対応（Firefox/Safari）では据え置き
```

`BASE_PATH` とパス反映プレフィックスは `window.location` から再利用することで保持される（GET フォーム横取りと同方式）。`location.*`（`assign` / `href` setter）自体はフック不能だが、結果生じる navigation を Navigation API の navigate イベントで捕捉し、**別ページへのプログラム遷移**は reflect 形式へ振り向ける（#172。Chromium 系のみ・feature-detect で additive）。**自己遷移は妨げず**、その後 `location` が browse コンテキストを失っても[実行時リクエスト横取りシム](#実行時リクエスト横取りシム注入sw-非依存124)の `pg()` フォールバックが中継を担保する。`history.pushState` / `history.replaceState` は上書きで URL をパス反映ナビ形式に保つ。クリック横取りは同一サイト内の SPA クライアントルーティングもフルナビゲーション化するトレードオフを持つが、history 上書きは URL 書き換えのみでナビゲーションを伴わない（spec 参照）。

### `document.domain` ドメインガード無効化シム注入

> 関連仕様: [プロキシ機能仕様 §`document.domain` ドメインガードの無効化](../spec/features/proxy.md#documentdomain-ドメインガードの無効化)

`rewriteHtml` は、ターゲットの**ホスト名（`new URL(baseUrl).hostname`）を返すよう `document.domain` を見せかけるシム `<script>`** を、ページ内スクリプトより先に実行されるよう **`<head>` 最先頭**へ注入する（他の注入が `<body>` 直後なのに対し、本シムだけは `<head>` 先頭）。一部サイト（例 Yahoo の `yjsecure.js`）が `document.domain` を正規表現で検査し、自オリジン外と判定するとトップフレームを実サイトへリダイレクトするため、プロキシ配下（`document.domain` がプロキシのホスト名）でガードが誤発火するのを防ぐ。

- **実装方式**: `Object.defineProperty(Document.prototype, 'domain', { get: () => <hostname>, set: () => {} })` で getter を上書きする（代入方式は `Origin-Agent-Cluster` 等で禁止され得るため不採用）。`try/catch` で例外を吸収する。
- **注入位置と最先頭性**: `yjsecure.js` は `templa.min.js` が `<head>` 段階で動的挿入し得るため、`<body>` 直後注入では間に合わない。`<head[^>]*>` 直後へ正規表現置換で注入する。`<head>` が無い HTML は `<html>` 直後、それも無ければ文書先頭へフォールバックする。
- **スコープ外**: `location.hostname` / `location.href` など `location` 全体を偽装する汎用シムは対象外（`document.domain` ベースのガード無効化に範囲を限定）。

### 実行時リクエスト横取りシム注入（SW 非依存・#124）

> 関連仕様: [プロキシ機能仕様 §実行時リクエスト横取りシム](../spec/features/proxy.md#実行時リクエスト横取りシムsw-非依存124)

`rewriteHtml` は、`window.fetch` ・ `XMLHttpRequest.prototype.open` ・ `navigator.sendBeacon` を上書きしてリクエスト URL を `/api/proxy/<scheme>/<host>/<path>` へ書き換える横取りシム `<script>`（`REQUEST_INTERCEPT_HTML`）を、ページ内スクリプトより先に実行されるよう **`<head>` 最先頭**へ注入する（`document.domain` シムと同様）。SW は初回ロードで `clients.claim()` 確立前のサブリソース要求を横取りできず、同一オリジン相対は 404・クロスオリジン XHR は CORS 失敗する。本シムは SW 制御の有無に依らずこのギャップを埋める。

| 純粋関数                                                            | 役割                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `isProxyOwnPath(pathname, basePath)`                                | 横取りしてはいけないプロキシ自前ルート（`/browse`・`/api/proxy/*`・`/sw.js`・`/favicon.ico`・ホーム。`/_next/*` は自前扱いしない〔#178〕）か判定する（`public/sw.js` の同名関数と対の規則）                                                                          |
| `buildRequestInterceptUrl(requestUrl, pageUrl, swOrigin, basePath)` | リクエスト URL を SW の `rewriteRequestUrl` と同一規則で `/api/proxy/<scheme>/<host>/<path>` へ書き換える。クロスオリジン絶対 URL はそのまま中継、同一オリジン非自前パスは閲覧ページからターゲット origin を復元して解決、自前ルート・非 http(s) は `null`（素通し） |

- **共有ヘルパー**: ターゲット復元は既存の純粋関数 `extractBrowseTarget` を再利用する。`buildRequestInterceptUrl` / `isProxyOwnPath` / `extractBrowseTarget` を `toString()` で `<script>` に埋め込む（外部参照を持たず `URL` のみで完結）。
- **SW との非競合**: シムの振り向け先（同一オリジンの `/api/proxy/...`）は SW が自前ルートと判定して素通しするため二重書き換えにならない。判定規則は `public/sw.js` と揃え、差分が出ないよう対で保守する（SW は `importScripts` 不可のためロジック共有はできず、両ファイルに同等実装を持つ）。
- **fetch / XHR / sendBeacon の配線**: `fetch` シムは `input` が文字列・`URL`・`Request` のいずれでも URL を取り出して書き換える（`Request` は新 `Request` で再構築）。XHR シムは `open(method, url)` の `url` を書き換える。`navigator.sendBeacon` シム（#168）は第 1 引数 URL を書き換え、第 2 引数 `data` はそのまま委譲し、戻り値の `boolean` も元実装の結果を返す（`navigator` を `this` として呼ぶ）。`navigator.sendBeacon` が無い環境では上書きしない。いずれも非 GET のメソッド・ボディ・ヘッダーを保持する。書き換え不要（`null`）なら元の `fetch` / `open` / `sendBeacon` を素通しする。
- **`pg()` フォールバック（browse コンテキスト喪失への耐性・#172）**: 注入時（`location` は閲覧ページ＝reflect 形式）の URL を `initPage` にキャッシュし、各書き換えで `pg()` を `pageUrl` として渡す。`pg()` は現 `location.href` が `extractBrowseTarget` でターゲットを復元できればそれを、できなければ（SPA の `location.replace('/')` 等で枠を外れた状態）`initPage` を返す。これにより `location` が枠を外れた後のルート相対リクエストも正しく中継される。完全ページ遷移時はシムが再注入され `initPage` も更新される。
- **テスト**: `isProxyOwnPath` / `buildRequestInterceptUrl`（純粋関数）を単体テスト対象とする。`window.fetch` / XHR の上書き配線・`pg()` フォールバック（ブラウザ I/O）は[テスト方針](../testing/policy.md)によりテスト対象外（方式B で実測検証）。

### 動的挿入要素の src 横取り注入（SW 非依存・#174）

> 関連仕様: [プロキシ機能仕様 §動的挿入要素の src 横取り](../spec/features/proxy.md#動的挿入要素の-src-横取りsw-非依存174)

同じ `REQUEST_INTERCEPT_HTML`（`<head>` 最先頭注入）内で、JS が実行時に動的挿入・代入した要素のリソース属性（`src`/`href`/`srcset`）を、サーバー側 `rewriteHtml` と同一規則で中継 URL へ書き換える。`fetch`/XHR/sendBeacon を経由しない `<script>`/`<link>`/メディア/`<iframe>` の動的読み込みが初回ロードの SW ギャップで離脱するのを防ぐ。

| 純粋関数                                                                         | 役割                                                                                                                                                                                                                                                                                                |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `buildElementSrcRewrite(tagName, attr, value, rel, pageUrl, swOrigin, basePath)` | 要素 (tag, attr) 種別に応じて中継 URL を決める。`iframe[src]` は `buildClickNavDestination`（/browse）、それ以外のアセット（`video[poster]` 含む・#183）は `buildRequestInterceptUrl`（/api/proxy）、`srcset` は候補ごとに書き換え。対象外タグ・非リソース `link`・既に proxy 枠・復元不能は `null` |

- **共有ヘルパー**: `buildRequestInterceptUrl`（/api/proxy）・`buildClickNavDestination`（/browse・`browseNavPrefix`/`buildBrowseDest`/`extractBrowseTarget` 依存）を `toString()` で同シムに埋め込む。`pg()` を fetch/XHR/sendBeacon と共有してターゲット origin を復元する。
- **横取り経路（重ねがけ）**: (1) 挿入メソッド（`Node.prototype.appendChild`/`insertBefore`/`replaceChild`、`Element.prototype.append`/`prepend`/`before`/`after`/`replaceWith`/`insertAdjacentElement`〔#180〕）で挿入ノード＋子孫を委譲前に書き換える（`<script>` は挿入時フェッチ＝主経路）、(2) `src`/`href`/`srcset`/`poster` プロパティ setter（#183）、(3) `Element.prototype.setAttribute`、(4) パーサ挿入（`insertAdjacentHTML`・`innerHTML`/`outerHTML` setter）の事前書き換え（#180。下記）、(5) `MutationObserver` バックストップ。いずれも `try/catch` で防御し、`buildElementSrcRewrite` が `null`（既に proxy 枠等）なら触らない（冪等）。
- **パーサ挿入の事前書き換え（#180）**: HTML 文字列を**フック前の元 `innerHTML` descriptor** で inert な `<template>` に解析し（template 内容は解析時フェッチなし）、`rwTree` 相当でサブツリーを書き換え、元 getter でシリアライズした文字列を元実装へ委譲する（再帰防止のため template 操作は元 descriptor 経由）。書き換えが 1 件も無ければ元の文字列をそのまま委譲する（ラウンドトリップ差異を持ち込まない）。接続済みサブツリーへのパーサ挿入は解析時に書き換え前 URL のフェッチが開始されるため、`MutationObserver` の事後補正では初回ロードの SW ギャップ中に離脱していた（#180。実測: GitHub テーマ CSS・Qiita スタイルシートの CDN 直行）。
- **`<script>` / `<link>` の SRI 除去**: `script[src]` / `link[href]` を書き換える際は `integrity`/`crossorigin` を除去する（サーバー側書き換えと同じ。/api/proxy 経由でハッシュ不一致ブロックを防ぐ。#188）。
- **既知の制限**: `document.write` / `document.writeln` は対象外（`MutationObserver` の事後補正のみ＝解析時の誤フェッチが先行し得る）。別オリジン iframe 内は当該フレームのシムが担う。CSS `url()`/`@import` は対象外。
- **テスト**: `buildElementSrcRewrite`（純粋関数）を単体テスト対象とする。挿入メソッド/setter/setAttribute/パーサ挿入/MutationObserver の配線（ブラウザ I/O）は[テスト方針](../testing/policy.md)により単体対象外（jsdom で代表配線を確認しつつ、最終的に方式B で実測検証）。

---

## Service Worker: `public/sw.js`

> 関連仕様: [プロキシ機能仕様 §Service Worker による実行時リクエスト横取り](../spec/features/proxy.md#service-worker-による実行時リクエスト横取り)

**役割**: 閲覧ページ内で JS が実行時に発行するリクエスト（**ナビゲーションを除く全メソッド**）を横取りし、`/api/proxy` 経由へ振り向ける。サーバー側 `rewriteHtml` が捕捉できない動的ロード（画像・スクリプト・XHR・非 GET API 呼び出し）を補完し、同一オリジン化により CORS プリフライトを消す（[機能仕様 §CORS プリフライト対応](../spec/features/proxy.md#cors-プリフライト対応)）。

### 登録

`rewriteHtml` が閲覧ページの `<body>` 直後（アドレスバーに続けて）に登録用 `<script>` を注入する。登録 URL は `${BASE_PATH}/sw.js`、スコープは `${BASE_PATH}/`。

- SW スクリプトは `self.registration.scope` から自身の `BASE_PATH` を導出する（リバースプロキシのパスプレフィックス対応。`next.config.mjs` は `basePath` 未使用のため、ブラウザから見えるスコープ＝プレフィックス込みのパスになる）。

### `fetch` ハンドラの処理

```
1. request.mode === "navigate":
   - destination が iframe / frame（サブフレーム）→ rewriteSubframeNavUrl で /browse/<scheme>/<host>/<path>
     を組み立て、Response.redirect(dest, 302) で振り向ける（dest が null〔自前ルート・非 http(s)・
     ターゲット不明〕なら fetch(req) 素通し）。#162
   - それ以外（destination=document のトップレベル遷移）→ 素通し（ページ遷移・フォーム送信に委ねる）
2. 同一オリジンの自前ルート（/browse・/api/proxy 等。/_next/* は自前扱いしない〔#178〕）→ 素通し
3. clientId から要求元ページ URL（パス反映 /browse/<scheme>/<host>/<path>・後方互換 /browse?url=<target>）を取得し、extractTarget でターゲットを復元する
4. rewriteRequestUrl(requestUrl, pageUrl, swOrigin, basePath) で振り向け先を決定
   （振り向け先はパス反映形式 /api/proxy/<scheme>/<host>/<path>。#100）
   - クロスオリジンの絶対 URL → /api/proxy/<scheme>/<host>/<path>
   - 同一オリジンのルート絶対パス（自前ルート以外）→ ターゲット origin に解決し /api/proxy/<scheme>/<host>/<path>
   - 同一オリジンの /_next/*（static チャンク・data・image 等）→ ターゲット origin に解決し /api/proxy/<scheme>/<host>/_next/...（#102・#178）
   - 自前ルート（パス反映済みの相対 import /api/proxy/* を含む）→ 素通し（null）
5. 振り向け先があれば fetch で応答（非 GET はメソッド・ボディ・リクエストヘッダーを保持、
   credentials: "same-origin"）。なければ素通し。振り向け fetch が失敗しても未処理 reject に
   せず Response.error() を返す
```

> メソッド非依存の URL 書き換えは純粋関数 `rewriteRequestUrl` が担い（メソッドで分岐しない）、非 GET のボディ・ヘッダー保持は `fetch` ハンドラ（ランタイム配線）側で行う。

**サブフレーム（iframe）ナビゲーションの横取り（#162）**: ランタイムで動的生成された `<iframe>` の root 相対 / 絶対 src は `mode=navigate` になり、トップレベル遷移と同じく素通しするとプロキシ自身の origin へ 404 着地する（実測: Dailymotion のプレイヤー iframe `/player/xtv3w.html`）。これを防ぐため、`destination` が `iframe` / `frame` の navigate のみ純粋関数 `rewriteSubframeNavUrl(requestUrl, pageUrl, swOrigin, basePath)` で `/browse/<scheme>/<host>/<path>` を組み立て、`Response.redirect(dest, 302)` で振り向ける。`rewriteSubframeNavUrl` は `rewriteRequestUrl` と対称だが、出力が `/api/proxy`（アセット）ではなく `/browse`（ブラウズ中継）である点が異なる。これにより iframe はブラウズ中継経路で読み込まれ、中継・書き換え・SW 登録・シム注入がフル適用される。クロスオリジン絶対 URL はそのまま `/browse` へ、同一オリジン root 相対パスは `extractTarget(pageUrl)` でターゲット origin を復元してから解決する。自前ルート（`/browse`・`/api/proxy` 等）・非 http(s)（`about:blank`・`data:` 等）・ターゲット不明は `null` を返し素通し（リダイレクト再帰・スキーム破壊・誤振り向けを防ぐ）。トップレベル（`destination=document`）の素通しは不変。

`isProxyOwnPath` は `/_next/*` を**自前ルート扱いにしない**（#178。#102 の `/_next/image` 特例を一般化）。`rewriteRequestUrl` の既存フォールバック（同一オリジンの非自前パス → ターゲット origin に解決）に委ね、Next.js 製ターゲットのクライアントランタイムが発行する `/_next/image?url=<外部>`（hydration の srcset 再生成 → 400 回避。#102）・`/_next/static/*` 遅延チャンク・`/_next/data/<buildId>/*.json`（SPA クライアント遷移のページデータ → 404・空白ページ回避。#178。実測: react.dev）をターゲット自身の `/_next` へ中継する。ターゲット不明のページ（ホーム等）では `extractTarget` が `null` を返し素通しされるため、プロキシ自身の `/_next` 資産提供には影響しない（プロキシ経由の閲覧ページはプロキシ自身の `/_next` 資産を使わない: アドレスバー UI・各シムはインライン注入。[機能仕様 §Service Worker](../spec/features/proxy.md#service-worker-による実行時リクエスト横取り)）。

### 純粋ロジックの分離とテスト

横取り判定・URL 解決・`/api/proxy` への書き換えは純粋関数として `public/sw.js` 内に定義し、`module.exports`（CommonJS）で公開する。SW ランタイム配線（`addEventListener('fetch', ...)`）は `importScripts` の有無で**ガード**し、Node（テスト）環境では実行されないようにする。これにより、配信される SW 本体の純粋ロジックを Node 環境のテストで直接検証でき、ロジックの重複を避ける（[テスト方針](../testing/policy.md) / `tests/lib/proxy/sw-intercept.test.ts`）。

### 制約（MVP）

- **トップレベルのナビゲーションは対象外**。トップレベルのページ遷移・フォーム送信はサーバー側書き換えに委ねる。ただしサブフレーム（iframe）の navigate は `/browse` へリダイレクト横取りする（#162・上記）。
- **`credentials: "same-origin"` で振り向け**。振り向け先は常に同一オリジンの `/api/proxy` であり、`__pxy_sid` セッション Cookie が `/api/proxy` まで届く。これにより `credentials: "include"` 相当の Cookie ベース・クロスオリジン XHR が、サーバー側 jar からの現ターゲット origin 分の復元（`cookieJar.cookieHeader`）に限定されたうえで成立する（#28。[機能仕様 §認証情報の転送 §セキュリティ上の制約](../spec/features/proxy.md#セキュリティ上の制約-1)）。ブラウザの `Cookie` 自体は上流へ転送しないため、プロキシ自身のインフラ認証 cookie（Cloudflare Access の `CF_Authorization` 等）も漏れない。元リクエストの `credentials` モードは区別せず一律 `same-origin` で振り向ける（既知の制約は同機能仕様を参照）。
- **ランタイム相対 module import はパス反映で解消（#100）**。アセットがパス反映形式（`/api/proxy/<scheme>/<host>/<path>`）で配信されるため、チャンク分割 SPA の相対 import はブラウザがモジュールのディレクトリ基準で正しく解決し、自前ルートとして素通しされルートが中継する（[機能仕様 §プロキシ URL スキーム](../spec/features/proxy.md#プロキシ-url-スキームパス反映)）。残る best-effort はクロスオリジン module からのルート絶対参照（referrer 不在のためページ target origin に振り向ける）。

---

## `src/lib/proxy/headers.ts`

**役割**: ターゲットのレスポンスヘッダーから不要なものを除去する。加えて、リクエスト側で転送する認証ヘッダー（`Cookie` / `Authorization`）の組み立ても担う。中継 Cookie の保持そのものは `cookieJar.ts`（サーバー側 jar）が担当し、`headers.ts` は jar から復元済みの `Cookie` 文字列を受け取って転送ヘッダーへ載せる（#151 Phase 1）。

除去対象（`Speculation-Rules` を含む）は [プロキシ機能仕様 §レスポンスヘッダー処理](../spec/features/proxy.md) を参照。前段 CDN が後段で注入する `Speculation-Rules` はコードからは除去できないため CDN 側設定で無効化する（同仕様の注記参照）。中継レスポンスの `Set-Cookie` は**ブラウザへ返さず**除去対象とし、保持は `cookieJar.ts` が担う。

### `htmlUiHeaders()`（プロキシ UI のクリックジャッキング防止・#131）

> 関連仕様: [プロキシ機能仕様 §プロキシ UI レスポンスのクリックジャッキング防止](../spec/features/proxy.md#プロキシ-ui-レスポンスのクリックジャッキング防止131) / [§サイト間アイソレーションの構造的制約](../spec/features/proxy.md#サイト間アイソレーションの構造的制約131)

プロキシ自身が生成する HTML UI レスポンス用のヘッダーを組み立てる純粋関数。`Content-Type: text/html; charset=utf-8` に加えて `X-Frame-Options: DENY` を付与する。これを使うのは `browseRelay.ts` の `htmlResponse`（エラー）/ `loopGuidanceResponse`（ループ案内）と `browse/route.ts` の `url` 未指定案内ページ（`noUrlBrowseHtml`）。`sanitizeHeaders` が中継レスポンスから `X-Frame-Options` を**除去**する（iframe 埋め込み中継のため）のと対になり、UI レスポンスには逆に**付与**して枠外埋め込みを禁止する。ホーム `/` は React コンポーネントでレスポンスヘッダーを直接付与できないため、この関数ではなく `next.config.mjs` の `headers()`（`source: '/'` 限定）で付与する。

### `sanitizeHeaders(headers, targetUrl?)`

> 関連仕様: [プロキシ機能仕様 §認証情報の転送](../spec/features/proxy.md#認証情報の転送cookie--authorization) / [§サイト間 Cookie アイソレーション](../spec/features/proxy.md#サイト間-cookie-アイソレーション) / [§`Link` ヘッダーの書き換え](../spec/features/proxy.md#link-ヘッダーの書き換え181)

レスポンスヘッダーをサニタイズする純粋関数。`BLOCKED_HEADERS`（`Content-Security-Policy` / `X-Frame-Options` / `Content-Encoding` / `Transfer-Encoding` / `Content-Length` / `Speculation-Rules`）に加えて **`Set-Cookie` を除去**し、中継 Cookie をブラウザへ返さない。`Set-Cookie` の保持は呼び出し側（`relayBrowse` / `relayAsset`）が `cookieJar.store(...)` で行うため、本関数は握り潰すだけ（#151 Phase 1）。`Set-Cookie` のスコープ化（旧 `sanitizeSetCookie` による名前接頭辞付与）は廃止した。

**`Link` ヘッダー（#181）**: `targetUrl` が渡された場合は `rewriteLinkHeader(value, targetUrl)` で書き換えて維持し、渡されない・書き換え結果が空の場合は除去する（素の URL を残さない fail-closed）。

### `rewriteLinkHeader(value, targetUrl)`

> 関連仕様: [プロキシ機能仕様 §`Link` ヘッダーの書き換え](../spec/features/proxy.md#link-ヘッダーの書き換え181)

上流 `Link:` ヘッダー値（RFC 8288）をエントリ単位で処理する純粋関数（#181）。`<...>`・quoted-string 内のカンマを区切りとして扱わない分割を行い、各エントリの `rel` で振り分ける: `preload` / `prefetch` / `modulepreload` は `<URL>` を `targetUrl` 基準で解決し `buildProxyPath`（`/api/proxy/<scheme>/<host>/<path>`・パス反映形式）へ書き換えて維持、`preconnect` / `dns-prefetch` は削除、その他（`canonical` 等）はそのまま維持。http(s) に解決できないフェッチ系エントリは削除。残エントリが無ければ `null`（呼び出し側がヘッダーごと除去）。

### `authorizationAllowed(incoming, targetOrigin)` / `originFromProxiedReferer(referer)`

> 関連仕様: [プロキシ機能仕様 §Authorization のオリジンスコープ](../spec/features/proxy.md#authorization-のオリジンスコープ136)

`Authorization` を宛先ターゲット origin へスコープするための判定ヘルパー（#136）。`originFromProxiedReferer(referer)` は受信 `Referer` 文字列を `URL` としてパースし、その `pathname` / `search` から `targetFromBrowsePath` → `targetFromProxyPath` → 後方互換 `?url=` の順で中継元ターゲット絶対 URL を復元し、その `origin` を返す純粋関数（復元不能なら `null`）。`authorizationAllowed(incoming, targetOrigin)` は `originFromProxiedReferer(incoming.get("referer"))` が `targetOrigin` と**完全一致**する場合のみ `true` を返す（`Referer` 欠落・パース不能・不一致はすべて `false` ＝ fail-closed）。`forwardableRequestHeaders` / `relayRequestHeaders` の両方が往路 `Authorization` の転送可否に用いる。

### `forwardableRequestHeaders(incoming, targetOrigin, jarCookie)`

> 関連仕様: [プロキシ機能仕様 §認証情報の転送](../spec/features/proxy.md#認証情報の転送cookie--authorization)

ターゲットへ転送する認証ヘッダーを組み立てる純粋関数。`Cookie` はブラウザ受信分を一切使わず、呼び出し側が `cookieJar.cookieHeader(sessionId, targetOrigin)` で復元した `jarCookie`（空なら付けない）を載せる。`Authorization` は受信 `Headers` から取り、`authorizationAllowed(incoming, targetOrigin)`（中継元 `Referer` 由来オリジンと `targetOrigin` の完全一致判定）が真のときのみ転送する（#136）。`GET` 中継（`/browse` GET / `/api/proxy` GET）が `proxyFetch` の `options.headers` へ渡す（`/browse` POST は `content-type` も併せて渡す）。全ヘッダー素通しは避け、転送対象を明示的に限定する。

### `relayRequestHeaders(incoming, targetOrigin, jarCookie)`

> 関連仕様: [プロキシ機能仕様 §CORS プリフライト対応](../spec/features/proxy.md#cors-プリフライト対応)

SW が `/api/proxy` へ振り向けた**非 GET 中継**向けに、リクエストヘッダーを**拒否リスト方式**で広めに転送する純粋関数。hop-by-hop・インフラ系（`host` / `connection` / `content-length` / `transfer-encoding` / `keep-alive` / `te` / `upgrade` / `accept-encoding`）に加え、プロキシ自身の文脈を漏らす `origin` / `referer`、ブラウザの `cookie`（プロキシ自身の `__pxy_sid` / `__pxy_auth` を上流へ漏らさないため）を除外し（#27）、さらに経路情報を漏らす `x-forwarded-host` / `x-forwarded-for` / `x-forwarded-proto` / `x-forwarded-port` / `forwarded` / `x-real-ip` を除外する（Next.js／リバースプロキシが受信リクエストへ自動付与し、転送すると上流のホスト検証で 403 になる。#198）。`Content-Type` / `Authorization` / `X-*` 等のカスタムヘッダーは残す。`X-CSRF-Token` などカスタムヘッダー依存の API を動かすため、許可リスト（`forwardableRequestHeaders`）より広く取る。転送する `Cookie` は呼び出し側が jar から復元した `jarCookie`（空なら付けない）。`Authorization` はサーバー側のスコープ機構が無いため、`authorizationAllowed(incoming, targetOrigin)`（中継元 `Referer` 由来オリジンと `targetOrigin` の完全一致判定）が真のときのみ転送する（#136）。

### `allowedCorsOrigin(origin, host)`

> 関連仕様: [プロキシ機能仕様 §CORS プリフライト対応](../spec/features/proxy.md#cors-プリフライト対応)

要求 `Origin` が `/api/proxy` リクエスト自身の `Host` と**同一オリジン**の場合のみその `origin` を返し、不一致・いずれか欠落・不正値なら `null` を返す純粋関数（#27）。`Host` は scheme を含まないため `new URL(origin).host` の host 部のみで照合する（TLS 終端リバプロでも公開 Host 同士で一致する）。SW が正当なサブリソースを同一オリジンの `/api/proxy` へ振り向けるため、許可すべきは自プロキシ origin のみ。OPTIONS 応答・中継レスポンスの CORS 許可判定に用いる。

### `buildCorsPreflightHeaders(origin, requestHeaders)`

> 関連仕様: [プロキシ機能仕様 §CORS プリフライト対応](../spec/features/proxy.md#cors-プリフライト対応)

`OPTIONS` 応答用の CORS 許可ヘッダー（`Access-Control-Allow-Methods/-Headers`・`Max-Age`・`Vary`、および許可時の `Access-Control-Allow-Origin/-Credentials`）を組み立てる純粋関数。`origin` は呼び出し側が `allowedCorsOrigin` で検証済みの値（許可 Origin または `null`）を渡す。**`origin` が非 null の場合のみ** `Access-Control-Allow-Origin` をエコーし `Allow-Credentials: true` を付ける（無検証エコー・`*` フォールバックは行わない。#27）。`Access-Control-Request-Headers` は従来どおりエコーする（無ければ `*`）。

---

## `src/lib/proxy/cookieJar.ts`（サーバー側 Cookie jar・#151 Phase 1）

> 関連仕様: [プロキシ機能仕様 §サイト間 Cookie アイソレーション](../spec/features/proxy.md#サイト間-cookie-アイソレーション) / [§サイト間アイソレーションの構造的制約](../spec/features/proxy.md#サイト間アイソレーションの構造的制約131)

**役割**: 中継先の `Set-Cookie` をクライアントへ返さず、サーバー側のインメモリ jar に **セッション × origin** 別で保持する。これにより中継 Cookie が `document.cookie` に現れなくなり、脅威 (a)（server-set Cookie 分）を塞ぐ。`rateLimit.ts` 等と同じく単一プロセス前提・プロセス再起動でリセット・複数インスタンス非共有。

### データ構造

```ts
// Map<sessionId, { origins: Map<origin, Map<cookieName, JarCookie>>, lastAccess }>
interface JarCookie {
  value: string;
  expiresAt: number | null;
} // null = セッション cookie
```

### セッション識別（純粋関数 + 生成）

- **`SESSION_COOKIE_NAME = "__pxy_sid"`**: jar を引くためのセッション ID Cookie 名。`__pxy.`（廃止した旧スコープ接頭辞）・`__pxy_auth`（`auth.ts`）と非衝突。
- **`newSessionId(): string`**: `crypto.randomUUID()` で不透明なセッション ID を生成する。
- **`buildSessionCookie(sessionId, basePath): string`**: `__pxy_sid=<id>; HttpOnly; SameSite=Lax; Path=<basePath || "/">` を組み立てる純粋関数（`buildAuthCookie` に倣い `Secure` は付けない＝TLS 終端構成）。
- **`resolveSession(cookieHeader): { id, isNew }`**: 受信 `Cookie` から `__pxy_sid` を読む（`auth.ts` の `parseCookieValue` を再利用）。あれば `{ id, isNew: false }`、無ければ新規 `{ id: newSessionId(), isNew: true }`。`isNew` の場合のみ呼び出し側がレスポンスへ `buildSessionCookie` を `Set-Cookie` する。
- **`parseSetCookie(setCookie, now): { name, value, expiresAt, deleted } | null`**: 1 行の `Set-Cookie` を解析する純粋関数。`Domain` は無視、`Max-Age`（相対）/ `Expires`（絶対）から `expiresAt` を算出し、`Max-Age<=0` や過去 `Expires` は `deleted` とする。`name=value` 形でなければ `null`。

### `CookieJar`（シングルトン `cookieJar`）

- **`store(sessionId, origin, setCookies, now?)`**: `res.headers.getSetCookie()` の配列を `parseSetCookie` で解析し、`deleted` は除去・それ以外は upsert する。セッションの `lastAccess` を更新し、origin あたりの保持数に上限を設ける。
- **`cookieHeader(sessionId, origin, now?): string`**: 当該セッション × origin の未失効エントリを `name=value; …` で連結して返す（無ければ空文字）。
- **GC**: 最終アクセスから `SESSION_TTL_MS` を過ぎたセッション・期限切れエントリを回収する。セッション総数の上限も設け、超過時は最古から退避する（`rateLimit.ts` の `evictExpired` と同方針）。スループット影響を避けるため `store` 呼び出し時に間引いて実行する。

### 呼び出し経路

- 往路: `relayAsset` / `browse` 系 route が `resolveSession(req)` → `cookieJar.cookieHeader(id, targetOrigin)` で `jarCookie` を得て、`forwardableRequestHeaders` / `relayRequestHeaders` の第 3 引数へ渡す。
- 復路: `relayBrowse` / `relayAsset` が上流レスポンス取得後に `cookieJar.store(id, new URL(finalUrl).origin, res.headers.getSetCookie())` で格納し、`isNew` セッションなら `outHeaders.append("Set-Cookie", buildSessionCookie(id, BASE_PATH))` を付ける。

---

## `src/lib/proxy/retry.ts`（上流 429 リトライ・#166）

**役割**: アセット中継が上流から受けた `429` を `Retry-After` 尊重で再試行するための、純粋ロジックと待機ユーティリティ。relayAsset 本体は現行方針でテスト対象外のため、判定・待機計算を純粋関数へ切り出して単体テスト可能にする。

> 関連機能仕様: [機能仕様 §アセット中継の上流 429 リトライ](../spec/features/proxy.md#アセット中継の上流-429-リトライretry-after-尊重166)。

### `parseRetryAfter(value, nowMs)`

`Retry-After` ヘッダー文字列を待機ミリ秒へ解釈する純粋関数。

- **秒数形式**（`"1"` 等の非負整数）: その秒数 × 1000 を返す。
- **HTTP-date 形式**（`"Wed, 21 Oct 2026 07:28:00 GMT"` 等）: `Date.parse` で解釈し、`nowMs` との差（負なら 0）を返す。
- **欠落（null）・解析不能**: `null` を返す（呼び出し側で既定待機にフォールバック）。

### `assetRetryConfigFromEnv(env = process.env)`

`PROXY_ASSET_RETRY_ATTEMPTS`（既定 1）/ `PROXY_ASSET_RETRY_MAX_WAIT_MS`（既定 2000）を読む純粋関数。`PROXY_ASSET_RETRY_ATTEMPTS` は **0 以上**の整数（0 は実質無効化）、`PROXY_ASSET_RETRY_MAX_WAIT_MS` は **正の整数**を受け付け、いずれも不正値・未設定は既定へフォールバック（`maxBufferBytesFromEnv` と同方針）。

### `computeRetryWaitMs(retryAfterHeader, nowMs, config)`

リトライ可否と待機 ms を一手に決める純粋関数。`relayAsset` のループはこの戻り値だけで分岐する。

- `parseRetryAfter` が `null`（欠落・解析不能）→ 短い既定待機 `min(DEFAULT_WAIT_MS=1000, config.maxWaitMs)`。
- 解析値が `config.maxWaitMs` 超 → **`null`（再試行しない＝429 即透過）**。
- それ以外 → 解析値（過去日時は 0）。

### `sleep(ms)`

`setTimeout` ベースの待機。I/O 相当のため純粋関数テストの対象外（`relayAsset` の配線でのみ使用）。

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

## `src/lib/proxy/targetPolicy.ts`（中継対象スキーム・ポート制限・#133）

**役割**: オープンプロキシ乱用対策として、中継先 URL のスキーム・ポートを許可リスト方式で検証する純粋関数群。中継本体（`relayAsset` / `browseGuards`）が上流取得の前に呼ぶ。仕様は [機能仕様 §中継対象スキーム・ポートの制限](../spec/features/proxy.md#中継対象スキームポートの制限133)。

- **`isAllowedTarget(parsed: URL, allowedPorts: Set<number>): boolean`**: スキームが `http:` / `https:` で、かつポート（明示なしはスキーム既定 80 / 443 を補完）が `allowedPorts` に含まれれば `true`。許可外は中継せず呼び出し側が `403` を返す。
- **`allowedPortsFromEnv(env = process.env): Set<number>`**: 既定の `{80, 443}` に、`PROXY_ALLOWED_PORTS`（カンマ区切り）の `1`〜`65535` の整数を追加した集合を返す。不正値は無視。既定の 80 / 443 は常に含まれ env で外せない。

`targetFromBrowsePath` / `targetFromProxyPath` は元から非対応スキームを `null`（→ 400）にするが、後方互換 `?url=` ルートやアセット入口を含む**全経路**でスキーム・ポートを揃えて検証するため本モジュールを共有する。

---

## `src/lib/proxy/concurrency.ts`（同時接続数の制限・#133）

**役割**: インメモリで「同時に処理中の中継数」をグローバル・IP 単位で制限する。レート制限（件数 / 分）と直交し、短時間の大量同時接続による資源枯渇・踏み台化を抑止する。仕様は [機能仕様 §同時接続数の制限](../spec/features/proxy.md#同時接続数の制限133)。

### データ構造

```ts
private global = 0;                       // グローバル同時処理数
private perIp = new Map<string, number>(); // IP 単位の同時処理数
```

### `ConcurrencyLimiter`（上限を設定可能）

`ConcurrencyLimiter(maxGlobal, maxPerIp)` をコンストラクタ引数で受け取る。`acquire(ip): () => void` の挙動:

- グローバルが `maxGlobal` 以上なら `ConcurrencyLimitExceededError("global")` を throw（→ 呼び出し側 `503`）。
- IP 単位が `maxPerIp` 以上なら `ConcurrencyLimitExceededError("ip")` を throw（→ 呼び出し側 `429`）。
- いずれにも達していなければ両カウンタを +1 し、**冪等な解放関数**を返す（複数回呼んでも 1 回だけ減算。`finally` での二重解放に耐える）。IP 単位が 0 になったエントリは `delete` してメモリ肥大を防ぐ。

環境から上限を読む純粋関数 **`concurrencyConfigFromEnv(env = process.env)`**（`PROXY_MAX_CONCURRENT` 既定 512 / `PROXY_MAX_CONCURRENT_PER_IP` 既定 64。正の整数以外・未設定は既定）を用い、シングルトン `relayConcurrencyLimiter` をモジュール読込時に生成する。中継本体は上流取得の直前に `acquire`、レスポンス構築後の `finally` で解放する（ストリーム透過本文の転送中は計上しない）。

### 制約

- インメモリ・単一プロセスのみ（`rateLimit.ts` と同様）。複数インスタンス構成では全体上限がインスタンス数倍になる。永続化・分散は v2 以降。

---

## `src/lib/proxy/auth.ts`（認証 / 接続元許可制・#148）

**役割**: 任意の共有トークン認証（既定オフ）の純粋関数群。`PROXY_AUTH_TOKEN` を設定したときのみ全中継経路で認証を要求する。中継本体（`browseGuards` / `relayAsset`）と解錠ルート（`/unlock`）が共通利用する。仕様は [機能仕様 §認証 / 接続元許可制](../spec/features/proxy.md#認証--接続元許可制任意148)。

### 定数・設定

- **`AUTH_COOKIE_NAME = "__pxy_auth"`** / **`AUTH_HEADER_NAME = "x-proxy-token"`**: トークン受け渡しに使う Cookie 名・ヘッダー名。`__pxy_auth` はプロキシ自身の Cookie で、往路はブラウザの `Cookie` を一切上流へ転送しない（jar から復元する。`cookieJar.ts`・#151 Phase 1）ためターゲットへ漏れない。`__pxy_sid`（セッション ID）とも別名。
- **`proxyAuthConfigFromEnv(env = process.env): { token: string } | null`**: `PROXY_AUTH_TOKEN` を trim して返す純粋関数（`clientIp.ts` 等の `*FromEnv` パターンに倣う）。未設定・空白のみは `null`（＝認証無効・オープン）。

### トークン検証（純粋関数）

- **`tokensMatch(presented: string | null, expected: string): boolean`**: タイミング攻撃を避ける**定数時間比較**。長さが違っても早期 return せず全長を走査する。`presented` が `null` なら `false`。
- **`parseCookieValue(cookieHeader: string | null, name: string): string | null`**: `Cookie` ヘッダー値から指定名の Cookie を取り出す純粋関数。
- **`presentedToken(headerValue: string | null, cookieHeader: string | null): string | null`**: `X-Proxy-Token` ヘッダー（優先）→ `__pxy_auth` Cookie の順に提示トークンを取り出す。
- **`isAuthorized(headerValue, cookieHeader, config): boolean`**: `config` が `null`（無効）なら常に `true`。有効なら `tokensMatch(presentedToken(...), config.token)`。

### 解錠 UI・Cookie・リダイレクト（純粋関数）

- **`buildAuthCookie(token: string, basePath: string): string`**: `__pxy_auth=<token>; HttpOnly; SameSite=Lax; Path=<basePath || "/">` を組み立てる。`Secure` は TLS 終端構成（アプリは http で受ける）を壊さないため付けない（トランスポート層の責務）。
- **`safeRedirectPath(raw: string | null, basePath: string): string`**: 解錠後の戻り先を検証する純粋関数。`/` 始まりかつ `//`（プロトコル相対）でないアプリ相対パスのみ通し、それ以外は `${basePath || ""}/` へフォールバック（オープンリダイレクト防止）。
- **`unlockHtml(redirectTo: string, basePath: string, opts?: { error?: boolean }): string`**: トークン入力フォーム付き 401 ページ。フォームは `POST {basePath}/unlock`（ブラウザ送信 URL のため `BASE_PATH` を前置）、隠しフィールドに `redirect`（アプリ相対・`BASE_PATH` なし）を持つ。`opts.error` で不一致メッセージを表示。

### 配線

- **`browseGuards`（`browseRelay.ts`）**: 先頭でレート制限より前に認証を検査し、未認証なら `unlockHtml` を `401`（`htmlUiHeaders` で `X-Frame-Options: DENY`）で返す。`redirect` は `req.nextUrl.pathname + search`（アプリ相対）。
- **`relayAsset`（`relayAsset.ts`）**: 入口で未認証なら `401`（プレーン）。レート制限・同時接続スロットを消費する前に弾く。
- **`/unlock`（`src/app/unlock/route.ts`）**: `POST` は `token` / `redirect` を読み、`tokensMatch` で検証。一致なら `Set-Cookie: buildAuthCookie(...)` 付きで `safeRedirectPath(redirect)`（`BASE_PATH` なしのアプリ相対 Location。リバースプロキシが prefix を再付加するため。#74）へ `303`。不一致は `unlockHtml(..., { error: true })` を `401`。`GET` は手動解錠用にフォーム（`200`）を返す。認証無効時はホームへ `303`。
- **SW / 横取りシム carve-out**: `isProxyOwnPath`（`rewrite.ts`）と `public/sw.js` の対の関数に `/unlock` を自前ルートとして追加し、フォーム POST が `/api/proxy` へ書き換えられないようにする。

### 制約

- 単一の共有トークン（利用者識別・個別失効なし）。トークンは Cookie 値・ヘッダーに平文で載るため TLS 終端必須。インメモリ状態を持たないため複数インスタンスでも同一トークンで一貫動作する。

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

## `src/lib/logger.ts`（共通ロガー・#138）

> 関連仕様: [プロキシ機能仕様 §エラーログとプライバシー](../spec/features/proxy.md#エラーログとプライバシー機微-url-のマスキング138)

**役割**: 中継処理の異常系ログを 1 か所に集約する横断ユーティリティ。閲覧先 URL・ホスト・IP は機微情報になり得る（OWASP A09:2021 / CWE-532）ため、出力前に**機微トークンを redact** し、**`PROXY_LOG_LEVEL` でレベル制御**する。`src/lib/proxy/` 配下ではなくクロスカッティングな `src/lib/` 直下に置く。

- `logLevelFromEnv(env = process.env)`: `PROXY_LOG_LEVEL` を読み、`silent` / `error` / `warn` / `info` / `debug` のいずれかを返す純粋関数（`*FromEnv` パターン）。未知値・未設定は既定 **`error`**。
- `maskSensitive(text)`: 任意文字列から **URL（`scheme://…`）・IPv4 / IPv6・素のホスト名（ドメイン）** を正規表現で検出し、`[redacted-url]` / `[redacted-ip]` / `[redacted-host]` へ置換する純粋関数。閲覧先ホスト自体が機微なため**全面 redact**（origin やパスを残さない）。安全側に倒すため過剰一致（例: メッセージ中の `foo.bar` 風トークン）は許容する。
- `formatError(err, includeStack = false)`: `Error` を `name: maskSensitive(message)` へ整形する。`name`（エラークラス名）は機微でないため残し、`message` と `cause`（ネイティブ fetch 失敗は `cause` にホストを含む）は redact する。`includeStack` 時のみスタックを redact 付きで添える。**`cause` は上限付き（5 段）で連鎖を辿る**（#236）。上流 fetch の失敗は `FetchTimeoutError` → `TypeError: fetch failed` → ランタイム側の実エラー、と多段になるため、1 段だけの展開では根本原因が出力されない（実際に #236 の切り分けを困難にした）。上限は `findSsrfCause`（`src/lib/proxy/fetch.ts`）と揃え、循環参照でも停止する。
- `logError(label, err)`: `logLevelFromEnv()` が `error` 以上のときだけ `console.error(label, formatError(err, level === "debug"))` を出力する。`silent` では何も出さない。スタックは `debug` のみ。

中継の 5 箇所の `console.error("[proxy/…]", err)`（`browseRelay.ts` の `browser-fallback` / `browse` / `auto-promote` / `browse-render`、`relayAsset.ts` の `asset`）はすべて `logError("[proxy/…]", err)` に置き換える。これにより、本番では既定で**機微 URL/ホストを伏せたエラーログのみ**が出力され、`PROXY_LOG_LEVEL=silent` で抑止・`=debug` でスタック付き診断ができる。

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
