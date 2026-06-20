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
  const init: ProxyRequestInit = {
    method,
    redirect: "follow",
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

export async function proxyFetch(
  url: string,
  options?: ProxyRequestOptions
): Promise<Response> {
  const parsed = new URL(url);
  // IPv4 に固定して解決する（IPv6 の SSRF 判定は v2 以降）
  const { address } = await dns.lookup(parsed.hostname, { family: 4 });

  if (isSsrfBlocked(address)) {
    throw new SsrfBlockedError(address);
  }

  try {
    return await fetch(url, {
      ...buildProxyRequestInit(options),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new FetchTimeoutError();
  }
}
