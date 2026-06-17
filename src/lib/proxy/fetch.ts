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
  return ip
    .split(".")
    .reduce((acc, octet) => (acc << 8) | parseInt(octet, 10), 0) >>> 0;
}

export function isSsrfBlocked(ip: string): boolean {
  if (ip === "::1") return true;

  const n = ipToInt(ip);
  return PRIVATE_RANGES.some(([lo, hi]) => n >= lo && n <= hi);
}

export async function proxyFetch(url: string): Promise<Response> {
  const parsed = new URL(url);
  const { address } = await dns.lookup(parsed.hostname);

  if (isSsrfBlocked(address)) {
    throw new SsrfBlockedError(address);
  }

  try {
    return await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(10_000),
      headers: { "User-Agent": "Mozilla/5.0 (compatible; web-proxy/1.0)" },
    });
  } catch {
    throw new FetchTimeoutError();
  }
}
