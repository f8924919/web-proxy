import dns from "dns/promises";

export class SsrfBlockedError extends Error {
  constructor(ip: string) {
    super(`Blocked SSRF target: ${ip}`);
    this.name = "SsrfBlockedError";
  }
}

export class FetchTimeoutError extends Error {
  constructor() {
    super("Proxy fetch timed out or target unreachable");
    this.name = "FetchTimeoutError";
  }
}

export class TooManyRedirectsError extends Error {
  constructor() {
    super("Too many redirects while following the target");
    this.name = "TooManyRedirectsError";
  }
}

const PRIVATE_RANGES: [number, number][] = [
  [ipToInt("127.0.0.0"), ipToInt("127.255.255.255")],
  [ipToInt("10.0.0.0"), ipToInt("10.255.255.255")],
  [ipToInt("172.16.0.0"), ipToInt("172.31.255.255")],
  [ipToInt("192.168.0.0"), ipToInt("192.168.255.255")],
  [ipToInt("169.254.0.0"), ipToInt("169.254.255.255")],
  [ipToInt("0.0.0.0"), ipToInt("0.255.255.255")],
];

function ipToInt(ip: string): number {
  return (
    ip
      .split(".")
      .reduce((acc, octet) => (acc << 8) | parseInt(octet, 10), 0) >>> 0
  );
}

export function isSsrfBlocked(ip: string): boolean {
  const n = ipToInt(ip);
  return PRIVATE_RANGES.some(([lo, hi]) => n >= lo && n <= hi);
}

export interface ProxyRequestOptions {
  /** ターゲットへ転送する HTTP メソッド（既定: GET）。 */
  method?: string;
  /** リクエストボディ。GET / HEAD では無視する。 */
  body?: BodyInit | ReadableStream | null;
  /** 転送する追加リクエストヘッダー（例: Content-Type）。既定ヘッダーへ上書き結合する。 */
  headers?: Record<string, string>;
}

// fetch の RequestInit は型定義上 duplex を持たないため拡張する
// （ReadableStream ボディ送信時に Node が要求する）。
type ProxyRequestInit = RequestInit & { duplex?: "half" };

// ターゲットへ送る既定 User-Agent。現代ブラウザ相当（Chrome 系）の固定文字列。
// 独自 UA だと一部サイト（例: yahoo.co.jp）が UA 判定で簡易レイアウトや「推奨ブラウザー」
// 警告ページを返し表示が崩れるため、フル版を取得できる現代ブラウザ UA を送る。
// 環境変数 PROXY_USER_AGENT（サーバー専用）で上書き可能。
// 仕様: docs/spec/features/proxy.md §ターゲットへ送る既定 User-Agent
export const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const BASE_HEADERS: Record<string, string> = {
  "Accept-Encoding": "identity",
};

// ヘッダー名の大文字小文字を区別せずに結合する（HTTP ヘッダー名はケース非依存＝ RFC 7230）。
// 後勝ち（後ろの source が同名ヘッダーを上書き）。非 GET 中継の relayRequestHeaders は
// 受信ヘッダーを小文字キー（例 user-agent）で返すため、既定の User-Agent（大文字）と
// 別キーで二重化させないために必要（#43）。同名は最後に指定されたキーの casing で 1 つに集約する。
function mergeHeadersCaseInsensitive(
  ...sources: (Record<string, string> | undefined)[]
): Record<string, string> {
  // lowercase 名 -> 出力キー の対応を持ち、同名の旧キーを消してから新キーを立てる。
  const byLower = new Map<string, string>();
  const merged: Record<string, string> = {};
  for (const source of sources) {
    if (!source) continue;
    for (const [name, value] of Object.entries(source)) {
      const lower = name.toLowerCase();
      const prevKey = byLower.get(lower);
      if (prevKey !== undefined) delete merged[prevKey];
      byLower.set(lower, name);
      merged[name] = value;
    }
  }
  return merged;
}

// proxyFetch が fetch に渡す RequestInit（signal を除く）を組み立てる純粋関数。
// 実 fetch（I/O）から分離してテスト可能にする。
// 仕様: docs/spec/features/proxy.md §POST 中継
export function buildProxyRequestInit(
  options: ProxyRequestOptions = {}
): ProxyRequestInit {
  const method = (options.method ?? "GET").toUpperCase();
  // 既定 UA は env で上書き可能。空文字は無効値として既定にフォールバックさせるため `||` を使う。
  const userAgent = process.env.PROXY_USER_AGENT || DEFAULT_USER_AGENT;
  // redirect は proxyFetch 側で "manual" を明示するためここでは設定しない（#26）。
  const init: ProxyRequestInit = {
    method,
    headers: mergeHeadersCaseInsensitive(
      { "User-Agent": userAgent },
      BASE_HEADERS,
      options.headers
    ),
  };

  // GET / HEAD はボディを持てない。それ以外でボディ指定時のみ転送する。
  if (options.body != null && method !== "GET" && method !== "HEAD") {
    init.body = options.body as BodyInit;
    // ReadableStream をボディに用いる場合は duplex: "half" が必須。
    if (options.body instanceof ReadableStream) {
      init.duplex = "half";
    }
  }

  return init;
}

// リダイレクト追従の上限。超過したらループとみなす（#26）。
const MAX_REDIRECTS = 5;

// fetch のタイムアウト（ミリ秒）。リダイレクト追従の全ホップで 1 枠を共有する。
const FETCH_TIMEOUT_MS = 10_000;

// 追従すべき 3xx ステータスか判定する（純粋関数）。
export function isRedirectStatus(status: number): boolean {
  return (
    status === 301 ||
    status === 302 ||
    status === 303 ||
    status === 307 ||
    status === 308
  );
}

// Location ヘッダーを現在 URL 基準で絶対 URL に解決する。不正なら null（純粋関数）。
export function resolveRedirectTarget(
  location: string,
  base: string
): string | null {
  try {
    return new URL(location, base).href;
  } catch {
    return null;
  }
}

// 2 つの URL が同一オリジン（スキーム・ホスト・ポート一致）か判定する。
// パース不能な場合は安全側に倒して false（別オリジン扱い）を返す（純粋関数）。
export function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

// 認証情報ヘッダー（Authorization / Cookie）をケース非依存で除去した新しいオブジェクトを返す。
// 別オリジンへのリダイレクト追従時に呼び、元のオブジェクトは破壊しない（純粋関数）。
export function stripCredentialHeaders(
  headers: Record<string, string>
): Record<string, string> {
  const sensitive = new Set(["authorization", "cookie"]);
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (sensitive.has(name.toLowerCase())) continue;
    result[name] = value;
  }
  return result;
}

// リダイレクト追従時の次ホップのメソッドとボディ送出可否を決める（純粋関数）。
// 301/302/303 は GET・ボディなしへ降格（一般的なブラウザ挙動）。307/308 はメソッドを
// 保持するが、再送不可ボディ（ReadableStream など）の場合は安全側で GET 降格する。
export function nextRedirectMethod(
  status: number,
  method: string,
  replayableBody: boolean
): { method: string; sendBody: boolean } {
  const m = method.toUpperCase();
  const bodyless = m === "GET" || m === "HEAD";
  if (status === 303) return { method: "GET", sendBody: false };
  if (status === 301 || status === 302) {
    return bodyless
      ? { method: m, sendBody: false }
      : { method: "GET", sendBody: false };
  }
  // 307 / 308
  if (bodyless) return { method: m, sendBody: false };
  return replayableBody
    ? { method: m, sendBody: true }
    : { method: "GET", sendBody: false };
}

// URL を DNS 解決し、SSRF ブロック対象なら SsrfBlockedError を throw する。
// 初回・リダイレクト追従先の双方から呼ぶ（#26）。browserFetch のサブリクエスト
// 傍受からも再利用するため公開する（#69）。
export async function assertSsrfAllowed(url: string): Promise<void> {
  const parsed = new URL(url);
  // IPv4 に固定して解決する（IPv6 の SSRF 判定は v2 以降）
  const { address } = await dns.lookup(parsed.hostname, { family: 4 });
  if (isSsrfBlocked(address)) {
    throw new SsrfBlockedError(address);
  }
}

export interface ProxyFetchResult {
  /** ターゲットからのレスポンス（リダイレクト追従後の最終応答）。 */
  response: Response;
  /** リダイレクト追従後の最終 URL（rewrite の baseUrl に用いる。#42）。 */
  finalUrl: string;
}

// ボディが複数回送出可能（リダイレクト追従で再送できる）か判定する。
// ReadableStream は一度きりで再送できないため false。
function isReplayableBody(body: unknown): boolean {
  return typeof body === "string" || body == null;
}

export async function proxyFetch(
  url: string,
  options?: ProxyRequestOptions
): Promise<ProxyFetchResult> {
  const init = buildProxyRequestInit(options);
  // 追従ホップ間で共有するタイムアウト（合計 10 秒）。
  const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);

  let currentUrl = url;
  let method = init.method ?? "GET";
  let headers = init.headers as Record<string, string>;
  let body = init.body;
  let duplex = init.duplex;

  for (let hop = 0; ; hop++) {
    // 初回・追従先とも fetch 前に SSRF を検査する。
    await assertSsrfAllowed(currentUrl);

    let res: Response;
    try {
      res = await fetch(currentUrl, {
        method,
        headers,
        body: body as BodyInit | undefined,
        ...(duplex ? { duplex } : {}),
        redirect: "manual",
        signal,
      });
    } catch {
      throw new FetchTimeoutError();
    }

    const location = isRedirectStatus(res.status)
      ? res.headers.get("location")
      : null;
    if (!location) {
      // リダイレクトでない（= 最終応答）。
      return { response: res, finalUrl: currentUrl };
    }

    if (hop >= MAX_REDIRECTS) throw new TooManyRedirectsError();

    const nextUrl = resolveRedirectTarget(location, currentUrl);
    // Location が解決できなければ追従せず 3xx をそのまま返す。
    if (!nextUrl) return { response: res, finalUrl: currentUrl };

    // 別オリジンへ追従する場合は認証情報を落とす（漏えい防止）。
    if (!sameOrigin(url, nextUrl)) {
      headers = stripCredentialHeaders(headers);
    }

    // 次ホップのメソッド・ボディを決める。降格時はボディと duplex を捨てる。
    const next = nextRedirectMethod(res.status, method, isReplayableBody(body));
    method = next.method;
    if (!next.sendBody) {
      body = undefined;
      duplex = undefined;
    }

    currentUrl = nextUrl;
  }
}
