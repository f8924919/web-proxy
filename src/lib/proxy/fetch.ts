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

const BASE_HEADERS: Record<string, string> = {
  "User-Agent": "Mozilla/5.0 (compatible; web-proxy/1.0)",
  "Accept-Encoding": "identity",
};

// proxyFetch が fetch に渡す RequestInit（signal を除く）を組み立てる純粋関数。
// 実 fetch（I/O）から分離してテスト可能にする。
// 仕様: docs/spec/features/proxy.md §POST 中継
export function buildProxyRequestInit(
  options: ProxyRequestOptions = {}
): ProxyRequestInit {
  const method = (options.method ?? "GET").toUpperCase();
  const init: ProxyRequestInit = {
    method,
    redirect: "follow",
    headers: { ...BASE_HEADERS, ...options.headers },
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
