const BLOCKED_HEADERS = new Set([
  "content-security-policy",
  "x-frame-options",
  "content-encoding",
  "transfer-encoding",
  // ブラウザがページ内 /browse?url=... リンクを prefetch してレート枠を消費するのを防ぐ。
  // 前段 CDN が後段で注入する分はコードからは消せない（docs/spec/features/proxy.md 参照）。
  "speculation-rules",
]);

export function sanitizeHeaders(headers: Headers): Headers {
  const result = new Headers();
  headers.forEach((value, name) => {
    if (!BLOCKED_HEADERS.has(name.toLowerCase())) {
      try {
        if (name.toLowerCase() === "set-cookie") {
          result.append(name, sanitizeSetCookie(value));
        } else {
          result.set(name, value);
        }
      } catch {
        // 不正な値（改行文字など）を含むヘッダーはスキップ
      }
    }
  });
  return result;
}

export function sanitizeSetCookie(value: string): string {
  return value
    .split(";")
    .map((part) => part.trim())
    .filter((part) => !/^domain=/i.test(part))
    .join("; ");
}

// プロキシ自身が認証プロキシ（Cloudflare Access 等）の背後にある場合、ブラウザは
// プロキシ origin の認証 cookie（CF_Authorization 等）も /api/proxy へ送る
// （SW が credentials: "same-origin" で振り向けるため）。これらはプロキシ自身の
// 認証情報であり、ターゲットへ転送すると別サイトへ Access の JWT が漏れる。
// 上流転送する Cookie からは除去する（小文字で比較）。
const STRIPPED_COOKIE_NAMES = new Set(["cf_authorization", "cf_appsession"]);

// Cookie ヘッダー値から、プロキシ自身のインフラ認証 cookie を除去する純粋関数。
// 除去後に残る cookie が無ければ空文字を返す（呼び出し側は Cookie を付けない）。
// 仕様: docs/spec/features/proxy.md §非 GET 中継のリクエストヘッダー転送
export function stripInfraCookies(cookieHeader: string): string {
  return cookieHeader
    .split(";")
    .map((part) => part.trim())
    .filter((part) => {
      if (part === "") return false;
      const name = part.split("=", 1)[0].trim().toLowerCase();
      return !STRIPPED_COOKIE_NAMES.has(name);
    })
    .join("; ");
}

// ターゲットへ転送してよいリクエスト認証ヘッダーの許可リスト。
// 全ヘッダー素通しを避け、明示的に限定する。
const FORWARD_REQUEST_HEADERS = ["cookie", "authorization"] as const;

// 受信リクエストの Headers から、転送対象の認証ヘッダー（Cookie / Authorization）を
// 許可リストで抽出する純粋関数。存在するヘッダーのみを含める。
// 各 Route Handler はこの結果を proxyFetch の options.headers へ渡す。
// 仕様: docs/spec/features/proxy.md §認証情報の転送
export function forwardableRequestHeaders(
  incoming: Headers
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of FORWARD_REQUEST_HEADERS) {
    const value = incoming.get(name);
    if (!value) continue;
    if (name === "cookie") {
      const stripped = stripInfraCookies(value);
      if (stripped) result[name] = stripped;
    } else {
      result[name] = value;
    }
  }
  return result;
}

// 非 GET 中継で転送しない hop-by-hop・インフラ系ヘッダー（拒否リスト）。
// accept-encoding は proxyFetch が identity 固定のため除外する。
const RELAY_BLOCKED_REQUEST_HEADERS = new Set([
  "host",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "content-length",
  "accept-encoding",
]);

// SW が /api/proxy へ振り向けた非 GET 中継向けに、リクエストヘッダーを
// 拒否リスト方式で広めに転送する純粋関数。Content-Type / Authorization /
// Cookie / X-* などカスタムヘッダーを保持し、ターゲットの API を動かす。
// 仕様: docs/spec/features/proxy.md §CORS プリフライト対応
export function relayRequestHeaders(incoming: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  incoming.forEach((value, name) => {
    const lower = name.toLowerCase();
    if (RELAY_BLOCKED_REQUEST_HEADERS.has(lower)) return;
    if (lower === "cookie") {
      const stripped = stripInfraCookies(value);
      if (stripped) result[name] = stripped;
      return;
    }
    result[name] = value;
  });
  return result;
}

// OPTIONS（CORS プリフライト）応答用の許可ヘッダーを組み立てる純粋関数。
// origin をエコーし（無ければ *）、Access-Control-Request-Headers をエコーする。
// origin がある場合のみ Allow-Credentials を付ける（* と credentials は併用不可）。
// 仕様: docs/spec/features/proxy.md §CORS プリフライト対応
export function buildCorsPreflightHeaders(
  origin: string | null,
  requestHeaders: string | null
): Headers {
  const headers = new Headers();
  headers.set("Access-Control-Allow-Origin", origin ?? "*");
  headers.set(
    "Access-Control-Allow-Methods",
    "GET, POST, PUT, PATCH, DELETE, OPTIONS"
  );
  headers.set("Access-Control-Allow-Headers", requestHeaders ?? "*");
  if (origin) headers.set("Access-Control-Allow-Credentials", "true");
  headers.set("Access-Control-Max-Age", "600");
  headers.set("Vary", "Origin");
  return headers;
}
