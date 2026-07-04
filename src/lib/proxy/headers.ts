import { targetFromBrowsePath } from "@/lib/proxy/browsePath";
import { targetFromProxyPath, buildProxyPath } from "@/lib/proxy/proxyPath";

const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

const BLOCKED_HEADERS = new Set([
  "content-security-policy",
  "x-frame-options",
  "content-encoding",
  "transfer-encoding",
  // 中継 Cookie はブラウザへ返さず（document.cookie 露出の遮断・#151 Phase 1）、保持は
  // cookieJar が担う。呼び出し側が res.headers.getSetCookie() を jar へ格納したうえで本関数で
  // 握り潰す。詳細は docs/spec/features/proxy.md §サイト間 Cookie アイソレーション。
  "set-cookie",
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

// Link ヘッダー値（RFC 8288）のエントリ区切りカンマで分割する。<...> と quoted-string 内の
// カンマは区切りとして扱わない。
function splitLinkEntries(value: string): string[] {
  const entries: string[] = [];
  let depth = false; // <...> 内
  let quoted = false; // "..." 内
  let start = 0;
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (quoted) {
      if (c === "\\")
        i++; // quoted-pair
      else if (c === '"') quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === "<") depth = true;
    else if (c === ">") depth = false;
    else if (c === "," && !depth) {
      entries.push(value.slice(start, i));
      start = i + 1;
    }
  }
  entries.push(value.slice(start));
  return entries.map((e) => e.trim()).filter((e) => e !== "");
}

// フェッチを誘発する rel（<URL> をターゲット基準で解決し /api/proxy へ書き換えて維持する）。
const LINK_FETCH_RELS = new Set(["preload", "prefetch", "modulepreload"]);
// 接続ヒント rel（接続先はプロキシ自身になり意味を成さないため削除する）。
const LINK_CONNECTION_RELS = new Set(["preconnect", "dns-prefetch"]);

// 上流の Link レスポンスヘッダーを書き換える純粋関数（#181）。素通しすると
// rel=preload 等をブラウザがヘッダー起点で素の URL へ直接プリロードし、DOM 書き換え・
// ランタイムシムが介在できず初回ロードの SW ギャップ中にプロキシ離脱する（実測: qiita.com）。
// エントリ単位で処理し、残エントリが無ければ null（呼び出し側がヘッダーごと除去）。
// 仕様: docs/spec/features/proxy.md §Link ヘッダーの書き換え（#181）
export function rewriteLinkHeader(
  value: string,
  targetUrl: string
): string | null {
  const kept: string[] = [];
  for (const entry of splitLinkEntries(value)) {
    const m = entry.match(/^<([^>]*)>([\s\S]*)$/);
    if (!m) continue; // 解析不能エントリは削除（素の URL を残さない）
    const [, url, params] = m;
    const relMatch = params.match(/;\s*rel\s*=\s*(?:"([^"]*)"|([^;\s]+))/i);
    const rels = (relMatch?.[1] ?? relMatch?.[2] ?? "")
      .toLowerCase()
      .split(/\s+/)
      .filter((r) => r !== "");
    if (rels.some((r) => LINK_CONNECTION_RELS.has(r))) continue;
    if (rels.some((r) => LINK_FETCH_RELS.has(r))) {
      let resolved: string;
      try {
        resolved = new URL(url, targetUrl).href;
      } catch {
        continue;
      }
      if (!resolved.startsWith("http://") && !resolved.startsWith("https://"))
        continue;
      kept.push(`<${buildProxyPath(resolved, BASE_PATH)}>${params}`);
      continue;
    }
    if (rels.length === 0) continue; // rel 無しは不正エントリとして削除
    kept.push(entry); // 情報系 rel（canonical / alternate 等）はそのまま維持
  }
  return kept.length ? kept.join(", ") : null;
}

// レスポンスヘッダーをサニタイズする純粋関数。BLOCKED_HEADERS（Set-Cookie を含む）を除去する。
// 中継 Cookie の保持は呼び出し側が cookieJar.store(...) で行うため、本関数は Set-Cookie を
// 握り潰すだけ（ブラウザへ返さない・#151 Phase 1）。
// Link ヘッダーは targetUrl があれば rewriteLinkHeader で書き換えて維持し、無ければ・
// 書き換え結果が空なら除去する（素の URL を残さない fail-closed・#181）。
// 仕様: docs/spec/features/proxy.md §レスポンスヘッダー処理 / §サイト間 Cookie アイソレーション
//       / §Link ヘッダーの書き換え（#181）
export function sanitizeHeaders(headers: Headers, targetUrl?: string): Headers {
  const result = new Headers();
  headers.forEach((value, name) => {
    const lower = name.toLowerCase();
    if (BLOCKED_HEADERS.has(lower)) return;
    try {
      if (lower === "link") {
        const rewritten = targetUrl
          ? rewriteLinkHeader(value, targetUrl)
          : null;
        if (rewritten != null) result.set(name, rewritten);
        return;
      }
      result.set(name, value);
    } catch {
      // 不正な値（改行文字など）を含むヘッダーはスキップ
    }
  });
  return result;
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

// ターゲットへ転送する認証ヘッダー（Cookie / Authorization）を組み立てる純粋関数。
// Cookie はブラウザ受信分を一切使わず、呼び出し側が cookieJar から復元した jarCookie
// （空文字なら付けない）を載せる（#151 Phase 1。document.cookie 露出の遮断）。
// Authorization は中継元 origin（Referer 由来）が宛先と一致する場合のみ転送する（#136）。
// 各 Route Handler はこの結果を proxyFetch の options.headers へ渡す。
// 仕様: docs/spec/features/proxy.md §認証情報の転送 / §サイト間 Cookie アイソレーション
export function forwardableRequestHeaders(
  incoming: Headers,
  targetOrigin: string,
  jarCookie: string
): Record<string, string> {
  const result: Record<string, string> = {};
  if (jarCookie) result.cookie = jarCookie;
  const authorization = incoming.get("authorization");
  if (authorization && authorizationAllowed(incoming, targetOrigin)) {
    result.authorization = authorization;
  }
  return result;
}

// 非 GET 中継で転送しない hop-by-hop・インフラ系ヘッダー（拒否リスト）。
// accept-encoding は proxyFetch が identity 固定のため除外する。
// origin / referer はプロキシ自身の origin・/browse?url=… 閲覧 URL をターゲットへ
// 漏らすため除外する（#27。サーバー間中継のため Origin 無し＝同一オリジン扱いと
// なり多くの API でむしろ整合する）。
// cookie はブラウザ受信分（プロキシ自身の __pxy_sid / __pxy_auth 等）を上流へ漏らさない
// ため除外し、転送する Cookie は cookieJar から復元した jarCookie だけを載せる（#151 Phase 1）。
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
  "cookie",
]);

// SW が /api/proxy へ振り向けた非 GET 中継向けに、リクエストヘッダーを
// 拒否リスト方式で広めに転送する純粋関数。Content-Type / Authorization /
// X-* などカスタムヘッダーを保持し、ターゲットの API を動かす。
// Cookie はブラウザ受信分を使わず、呼び出し側が cookieJar から復元した jarCookie
// （空文字なら付けない）を載せる（#151 Phase 1）。Authorization は中継元 origin
// （Referer から復元）が宛先 targetOrigin と一致する場合のみ転送する（authorizationAllowed。#136）。
// 仕様: docs/spec/features/proxy.md §CORS プリフライト対応 / §サイト間 Cookie アイソレーション / §Authorization のオリジンスコープ
export function relayRequestHeaders(
  incoming: Headers,
  targetOrigin: string,
  jarCookie: string
): Record<string, string> {
  const result: Record<string, string> = {};
  if (jarCookie) result.cookie = jarCookie;
  incoming.forEach((value, name) => {
    const lower = name.toLowerCase();
    if (RELAY_BLOCKED_REQUEST_HEADERS.has(lower)) return;
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
