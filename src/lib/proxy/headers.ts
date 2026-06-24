import { targetFromBrowsePath } from "@/lib/proxy/browsePath";
import { targetFromProxyPath } from "@/lib/proxy/proxyPath";

const BLOCKED_HEADERS = new Set([
  "content-security-policy",
  "x-frame-options",
  "content-encoding",
  "transfer-encoding",
  // 上流が identity 要求を無視して gzip 応答すると、fetch は本文を展開して渡すが上流の
  // content-length は圧縮時サイズのまま残る。content-encoding を除去しつつこの値を転送すると
  // 実本文長と宣言長が食い違い ERR_CONTENT_LENGTH_MISMATCH／本文切り詰めを招く（#97）。
  // 除去してランタイムに再計算（または chunked）させる。詳細は docs/spec/features/proxy.md。
  "content-length",
  // ブラウザがページ内 /browse?url=... リンクを prefetch してレート枠を消費するのを防ぐ。
  // 前段 CDN が後段で注入する分はコードからは消せない（docs/spec/features/proxy.md 参照）。
  "speculation-rules",
]);

// プロキシ自身が生成する HTML UI レスポンス（ホーム以外：エラー / ループ案内 /
// url 未指定案内ページ）用のヘッダーを組み立てる純粋関数。中継レスポンスから
// X-Frame-Options を除去する（iframe 埋め込み中継のため）のと対になり、UI レスポンス
// には逆に X-Frame-Options: DENY を付与して枠外埋め込み（クリックジャッキング）を禁止する。
// ホーム / は React コンポーネントのため next.config.mjs の headers() で付与する。
// 仕様: docs/spec/features/proxy.md §プロキシ UI レスポンスのクリックジャッキング防止（#131）
export function htmlUiHeaders(): Record<string, string> {
  return {
    "Content-Type": "text/html; charset=utf-8",
    "X-Frame-Options": "DENY",
  };
}

export function sanitizeHeaders(
  headers: Headers,
  targetOrigin: string
): Headers {
  const result = new Headers();
  headers.forEach((value, name) => {
    if (!BLOCKED_HEADERS.has(name.toLowerCase())) {
      try {
        if (name.toLowerCase() === "set-cookie") {
          result.append(name, sanitizeSetCookie(value, targetOrigin));
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

// サイト間 Cookie アイソレーション用の接頭辞。区切り "." は base64url が使わない
// 文字なので、復元時に最初の "." でスコープ鍵と元の Cookie 名を一意に分離できる。
// 仕様: docs/spec/features/proxy.md §サイト間 Cookie アイソレーション
const COOKIE_SCOPE_PREFIX = "__pxy.";

// ターゲット origin から Cookie 名へ付与するスコープ鍵（base64url(origin)）を生成する
// 純粋関数。URL.origin は IDN を punycode 化するため ASCII で、Cookie 名 token に
// 使える文字のみになる。
// 仕様: docs/spec/features/proxy.md §サイト間 Cookie アイソレーション
export function cookieScopeKey(origin: string): string {
  return btoa(origin)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

// Set-Cookie 値から Domain 属性を除去し、Cookie 名をターゲット origin でスコープ化する
// 純粋関数。Path / Secure / SameSite は維持する。
// 仕様: docs/spec/features/proxy.md §サイト間 Cookie アイソレーション
export function sanitizeSetCookie(value: string, targetOrigin: string): string {
  const parts = value
    .split(";")
    .map((part) => part.trim())
    .filter((part) => !/^domain=/i.test(part));

  const [nameValue, ...attrs] = parts;
  const eq = nameValue.indexOf("=");
  // name=value の形でなければスコープ化できないため、Domain 除去のみで返す。
  if (eq === -1) return parts.join("; ");

  const name = nameValue.slice(0, eq);
  const cookieValue = nameValue.slice(eq + 1);
  const scopedName = `${COOKIE_SCOPE_PREFIX}${cookieScopeKey(targetOrigin)}.${name}`;
  return [`${scopedName}=${cookieValue}`, ...attrs].join("; ");
}

// 受信 Cookie ヘッダー値から、targetOrigin のスコープ鍵に一致する Cookie だけを抽出し、
// 接頭辞を外して元の名前で連結する純粋関数。別 origin にスコープされた Cookie・
// 非スコープの Cookie（プロキシ自身のインフラ認証 cookie 等）は除外される。
// 残る Cookie が無ければ空文字を返す（呼び出し側は Cookie ヘッダーを付けない）。
// 仕様: docs/spec/features/proxy.md §サイト間 Cookie アイソレーション
export function scopedCookieHeader(
  cookieHeader: string,
  targetOrigin: string
): string {
  const prefix = `${COOKIE_SCOPE_PREFIX}${cookieScopeKey(targetOrigin)}.`;
  return cookieHeader
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(prefix))
    .map((part) => part.slice(prefix.length))
    .join("; ");
}

// 受信 Referer（プロキシ origin の URL）から中継元ページのターゲット origin を復元する
// 純粋関数。Referer のパスにはターゲットが反映されている（パス反映ナビ /browse/<scheme>/<host>/…
// ・パス反映アセット /api/proxy/<scheme>/<host>/… ・後方互換 /browse?url=<絶対URL>）。
// いずれの形式でも復元できなければ（Referer 欠落・パース不能・マーカー無し等）null を返す。
// 仕様: docs/spec/features/proxy.md §Authorization のオリジンスコープ（#136）
function originFromProxiedReferer(referer: string | null): string | null {
  if (!referer) return null;
  let ref: URL;
  try {
    ref = new URL(referer);
  } catch {
    return null;
  }
  const target =
    targetFromBrowsePath(ref.pathname, ref.search) ??
    targetFromProxyPath(ref.pathname, ref.search) ??
    legacyUrlParam(ref);
  if (!target) return null;
  try {
    return new URL(target).origin;
  } catch {
    return null;
  }
}

// 後方互換 ?url= 形式の Referer（/browse?url=<絶対URL>）からターゲット絶対 URL を取り出す。
// http(s) 以外・欠落・不正値は null。パス反映形式が先に一致するため、これが効くのは
// パス反映マーカーを持たない素の /browse パスの場合に限られる。
function legacyUrlParam(ref: URL): string | null {
  const url = ref.searchParams.get("url");
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.href;
  } catch {
    return null;
  }
}

// Authorization をターゲットへ転送してよいかを判定する純粋関数。中継元ページの origin
// （受信 Referer から復元）が宛先ターゲット origin と完全一致する場合のみ true。Cookie の
// ようなスコープ鍵を値へ埋め込めないため、中継元シグナル（Referer）で振り向け先一致を
// 検証する。Referer 欠落・パース不能・不一致はすべて false（fail-closed）。
// 仕様: docs/spec/features/proxy.md §Authorization のオリジンスコープ（#136）
function authorizationAllowed(
  incoming: Headers,
  targetOrigin: string
): boolean {
  const source = originFromProxiedReferer(incoming.get("referer"));
  return source !== null && source === targetOrigin;
}

// ターゲットへ転送してよいリクエスト認証ヘッダーの許可リスト。
// 全ヘッダー素通しを避け、明示的に限定する。
const FORWARD_REQUEST_HEADERS = ["cookie", "authorization"] as const;

// 受信リクエストの Headers から、転送対象の認証ヘッダー（Cookie / Authorization）を
// 許可リストで抽出する純粋関数。存在するヘッダーのみを含める。
// 各 Route Handler はこの結果を proxyFetch の options.headers へ渡す。
// 仕様: docs/spec/features/proxy.md §認証情報の転送
export function forwardableRequestHeaders(
  incoming: Headers,
  targetOrigin: string
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of FORWARD_REQUEST_HEADERS) {
    const value = incoming.get(name);
    if (!value) continue;
    if (name === "cookie") {
      const scoped = scopedCookieHeader(value, targetOrigin);
      if (scoped) result[name] = scoped;
    } else if (name === "authorization") {
      // Authorization は中継元 origin が宛先と一致する場合のみ転送する（#136）。
      if (authorizationAllowed(incoming, targetOrigin)) result[name] = value;
    } else {
      result[name] = value;
    }
  }
  return result;
}

// 非 GET 中継で転送しない hop-by-hop・インフラ系ヘッダー（拒否リスト）。
// accept-encoding は proxyFetch が identity 固定のため除外する。
// origin / referer はプロキシ自身の origin・/browse?url=… 閲覧 URL をターゲットへ
// 漏らすため除外する（#27。サーバー間中継のため Origin 無し＝同一オリジン扱いと
// なり多くの API でむしろ整合する）。
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
  "origin",
  "referer",
]);

// SW が /api/proxy へ振り向けた非 GET 中継向けに、リクエストヘッダーを
// 拒否リスト方式で広めに転送する純粋関数。Content-Type / Authorization /
// Cookie / X-* などカスタムヘッダーを保持し、ターゲットの API を動かす。
// Authorization は中継元 origin（Referer から復元）が宛先 targetOrigin と一致する
// 場合のみ転送する（authorizationAllowed。#136）。
// 仕様: docs/spec/features/proxy.md §CORS プリフライト対応 / §Authorization のオリジンスコープ
export function relayRequestHeaders(
  incoming: Headers,
  targetOrigin: string
): Record<string, string> {
  const result: Record<string, string> = {};
  incoming.forEach((value, name) => {
    const lower = name.toLowerCase();
    if (RELAY_BLOCKED_REQUEST_HEADERS.has(lower)) return;
    if (lower === "cookie") {
      const scoped = scopedCookieHeader(value, targetOrigin);
      if (scoped) result[name] = scoped;
      return;
    }
    if (lower === "authorization") {
      // Authorization は中継元 origin が宛先と一致する場合のみ転送する（#136）。
      if (authorizationAllowed(incoming, targetOrigin)) result[name] = value;
      return;
    }
    result[name] = value;
  });
  return result;
}

// 要求 Origin が /api/proxy リクエスト自身の Host と同一オリジンの場合のみ、その
// origin を返す純粋関数。不一致・いずれか欠落・不正値なら null。SW は正当な
// サブリソースを同一オリジンの /api/proxy へ振り向けるため許可すべきは自プロキシ
// origin のみで、第三者クロスオリジンへの無検証エコー＋Allow-Credentials を防ぐ。
// host は scheme を含まないため Origin の host 部のみで照合する（TLS 終端
// リバプロでも公開 Host 同士で一致する。#27）。
// 仕様: docs/spec/features/proxy.md §CORS プリフライト対応
export function allowedCorsOrigin(
  origin: string | null,
  host: string | null
): string | null {
  if (!origin || !host) return null;
  try {
    return new URL(origin).host === host ? origin : null;
  } catch {
    return null;
  }
}

// OPTIONS（CORS プリフライト）応答用の許可ヘッダーを組み立てる純粋関数。
// origin は呼び出し側が allowedCorsOrigin で検証済みの値（許可 origin または null）。
// origin が非 null の場合のみ Allow-Origin をエコーし Allow-Credentials を付ける
// （無検証エコー・* フォールバックは行わない。#27）。
// Access-Control-Request-Headers は従来どおりエコーする（無ければ *）。
// 仕様: docs/spec/features/proxy.md §CORS プリフライト対応
export function buildCorsPreflightHeaders(
  origin: string | null,
  requestHeaders: string | null
): Headers {
  const headers = new Headers();
  headers.set(
    "Access-Control-Allow-Methods",
    "GET, POST, PUT, PATCH, DELETE, OPTIONS"
  );
  headers.set("Access-Control-Allow-Headers", requestHeaders ?? "*");
  if (origin) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Access-Control-Allow-Credentials", "true");
  }
  headers.set("Access-Control-Max-Age", "600");
  headers.set("Vary", "Origin");
  return headers;
}
