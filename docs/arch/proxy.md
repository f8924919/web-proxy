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
└── lib/
    └── proxy/
        ├── fetch.ts          # SSRF チェック付き fetch
        ├── rewrite.ts        # HTML / CSS URL 書き換え
        ├── headers.ts        # レスポンスヘッダー処理
        ├── rateLimit.ts      # インメモリ レート制限
        └── response.ts       # nullBodyStatus 判定ユーティリティ
```

---

## Route Handler: `src/app/browse/route.ts`

**役割**: ブラウズ画面の生 HTML レスポンスを返す。React を介さない。

### 処理フロー

```
1. searchParams.get('url') を取得
2. url が null / パース失敗 → 307 リダイレクト to /
3. rateLimit.check(ip) → 超過なら 429
4. proxyFetch(url) → SSRF ブロックなら 403 / 到達不能なら 502
5. rewriteHtml(html, baseUrl) でアドレスバー HTML を先頭に注入 + URL 書き換え
6. headers.sanitize(responseHeaders) でヘッダーを除去
7. new Response(rewrittenHtml, { headers }) を返す
   （非 HTML はそのまま中継。204/205/304 はボディ null、1xx・範囲外・変換中の例外は 502。
    [機能仕様 §ステータスコードの中継](../spec/features/proxy.md#ステータスコードの中継) 参照）
```

### アドレスバー注入

`</body>` タグ直前ではなく、`<body>` タグ直後にインラインスタイルで貼り付ける小さな HTML フラグメントを注入する。外部 CSS 依存なし。

---

## Route Handler: `src/app/api/proxy/route.ts`

**役割**: 静的アセット（CSS・画像・JS）を透過中継する。

### 処理フロー

```
1. searchParams.get('url') を取得
2. url が null → 400
3. rateLimit.check(ip) → 超過なら 429
4. proxyFetch(url) → SSRF ブロックなら 403
5. Content-Type が text/css → rewriteCss(body, baseUrl)
6. headers.sanitize(responseHeaders)
7. Response を中継して返す
   （204/205/304 はボディを null として返す。1xx・ステータス範囲外・
    Response 構築・CSS 読取り/変換中の未捕捉例外は 502。
    [機能仕様 §ステータスコードの中継](../spec/features/proxy.md#ステータスコードの中継) 参照）
```

---

## `src/lib/proxy/fetch.ts`

**役割**: SSRF チェックを行ったうえでターゲットへ fetch する。

### SSRF チェック

1. `URL` でパース（失敗なら例外）
2. `dns.promises.lookup(hostname)` で IP を解決
3. 解決した IP を CIDR ブロックリストと照合（[プロキシ機能仕様 §SSRF 対策](../spec/features/proxy.md) 参照）
4. ブロック対象なら `SsrfBlockedError` を throw
5. `fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(10_000) })` で取得

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

---

## `src/lib/proxy/headers.ts`

**役割**: ターゲットのレスポンスヘッダーから不要なものを除去する。

除去対象は [プロキシ機能仕様 §レスポンスヘッダー処理](../spec/features/proxy.md) を参照。

`Set-Cookie` の `Domain` 属性を除去する処理もここで行う。

---

## `src/lib/proxy/rateLimit.ts`

**役割**: インメモリ・スライディングウィンドウによるレート制限。

### データ構造

```ts
// Map<ip, タイムスタンプ配列（直近60秒分）>
const store = new Map<string, number[]>();
```

### `check(ip: string): void`

- 現在時刻から60秒以内のタイムスタンプのみ残す
- 60件以上なら `RateLimitExceededError` を throw
- 現在時刻を追記

### 制約

- Node.js runtime のインメモリのみ。プロセス再起動でリセットされる。
- 複数 Next.js インスタンスをまたいだ共有は非対応（v2 以降）。

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
assetPrefix: process.env.NEXT_PUBLIC_BASE_PATH ?? ""
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
