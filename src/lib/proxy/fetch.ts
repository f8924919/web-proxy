import dns from "dns/promises";
import { lookup as dnsLookup } from "node:dns";
import net from "node:net";
import { Agent } from "undici";

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

// 中継本文が許容サイズ上限を超えた（呼び出し側は 413 を返す）。#134
export class BodyTooLargeError extends Error {
  constructor() {
    super("Relay body exceeds the size limit");
    this.name = "BodyTooLargeError";
  }
}

// HTML / CSS の全量バッファ上限の既定値（10 MiB）。仕様: docs/spec/features/proxy.md
// §中継本文のサイズ上限（メモリ枯渇 DoS 対策・#134）
const DEFAULT_MAX_BUFFER_BYTES = 10 * 1024 * 1024;

// env から全量バッファ上限（バイト）を読む純粋関数。PROXY_MAX_BUFFER_BYTES が正の整数なら
// それを、未設定・不正値（非整数・0 以下）なら既定 10 MiB を返す（browserFetch の *FromEnv 同様）。
export function maxBufferBytesFromEnv(
  env: Record<string, string | undefined> = process.env
): number {
  const raw = env.PROXY_MAX_BUFFER_BYTES?.trim();
  if (!raw) return DEFAULT_MAX_BUFFER_BYTES;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_MAX_BUFFER_BYTES;
}

// res.text() の代替。書き換えのため全量バッファする HTML / CSS 本文にサイズ上限を課す純粋関数。
// ① Content-Length が maxBytes 超過を宣言していれば、本文を読む前に BodyTooLargeError を投げる。
// ② res.body をチャンク読みし、累積バイト数が maxBytes を超えたらストリームを cancel して投げる。
// 上限内なら resolveCharset で判定した文字コードでデコードした文字列を返す（res.body が無ければ
// 空文字）。サイズ上限の累積判定はデコード前の生バイト列で行う（charset 追従後も 413 挙動は不変・#158）。
// 仕様: docs/spec/features/proxy.md §中継本文のサイズ上限（メモリ枯渇 DoS 対策・#134）
export async function readTextWithLimit(
  res: Response,
  maxBytes: number
): Promise<string> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new BodyTooLargeError();
  }
  if (!res.body) return "";

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new BodyTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return decodeBody(merged, res.headers.get("content-type"));
}

// 本文先頭を ASCII として走査して charset 宣言を sniff する範囲（バイト）。
// HTML/CSS の charset 宣言は規約上 head 先頭・ファイル先頭に来るため、先頭のみで十分。
const SNIFF_LIMIT_BYTES = 4096;

// charset ラベルを正規化する（前後空白・引用符を除去し小文字化）。空なら null。
function normalizeCharsetLabel(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const label = raw
    .trim()
    .replace(/^["']|["']$/g, "")
    .trim()
    .toLowerCase();
  return label || null;
}

// 中継本文の文字コードを判定する純粋関数（#158）。
// 優先順: ①Content-Type の charset → ②本文先頭の sniff（HTML <meta> / CSS @charset）→ ③utf-8。
// 仕様: docs/spec/features/proxy.md §中継本文の文字コード処理（#158）
export function resolveCharset(
  contentType: string | null | undefined,
  bytes: Uint8Array
): string {
  // ① Content-Type ヘッダーの charset。
  const fromHeader = normalizeCharsetLabel(
    /charset=([^;]+)/i.exec(contentType ?? "")?.[1]
  );
  if (fromHeader) return fromHeader;

  // ② 本文先頭を ASCII として読み、HTML の <meta>・CSS の @charset を sniff する。
  // 非 ASCII バイトはマークアップに現れないため latin1 解釈で取りこぼさない。
  const head = new TextDecoder("latin1").decode(
    bytes.subarray(0, SNIFF_LIMIT_BYTES)
  );
  const fromMetaCharset = normalizeCharsetLabel(
    /<meta[^>]+charset=["']?([^"'\s/>]+)/i.exec(head)?.[1]
  );
  if (fromMetaCharset) return fromMetaCharset;
  const fromMetaHttpEquiv = normalizeCharsetLabel(
    /<meta[^>]+http-equiv=["']?content-type["']?[^>]*content=["'][^"']*charset=([^"'\s;]+)/i.exec(
      head
    )?.[1]
  );
  if (fromMetaHttpEquiv) return fromMetaHttpEquiv;
  const fromCssCharset = normalizeCharsetLabel(
    /^@charset\s+["']([^"']+)["']/i.exec(head)?.[1]
  );
  if (fromCssCharset) return fromCssCharset;

  // ③ いずれも無ければ UTF-8。
  return "utf-8";
}

// 判定した charset で本文をデコードする。未知・不正ラベルは UTF-8 にフォールバックし、
// 中継を例外で失敗させない（#158）。Node 組込み TextDecoder が euc-jp / shift_jis /
// iso-2022-jp 等を標準サポートするため追加依存は不要。
function decodeBody(bytes: Uint8Array, contentType: string | null): string {
  const charset = resolveCharset(contentType, bytes);
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

// SSRF ブロック対象の IPv4 レンジ（[下限, 上限] の閉区間・32bit 整数）。
// 仕様: docs/spec/features/proxy.md §SSRF 対策
const PRIVATE_RANGES_V4: [number, number][] = [
  [ipToInt("127.0.0.0"), ipToInt("127.255.255.255")], // ループバック
  [ipToInt("10.0.0.0"), ipToInt("10.255.255.255")], // RFC1918 class A
  [ipToInt("172.16.0.0"), ipToInt("172.31.255.255")], // RFC1918 class B
  [ipToInt("192.168.0.0"), ipToInt("192.168.255.255")], // RFC1918 class C
  [ipToInt("169.254.0.0"), ipToInt("169.254.255.255")], // リンクローカル（メタデータ含む）
  [ipToInt("100.64.0.0"), ipToInt("100.127.255.255")], // CGNAT 100.64.0.0/10（#130）
  [ipToInt("0.0.0.0"), ipToInt("0.255.255.255")], // 未指定
];

function ipToInt(ip: string): number {
  return (
    ip
      .split(".")
      .reduce((acc, octet) => (acc << 8) | parseInt(octet, 10), 0) >>> 0
  );
}

function isBlockedV4(ip: string): boolean {
  const n = ipToInt(ip);
  return PRIVATE_RANGES_V4.some(([lo, hi]) => n >= lo && n <= hi);
}

// IPv6 のブロック判定（#130）。IPv4-mapped（::ffff:a.b.c.d / ::ffff:hi:lo）は対応する
// IPv4 として委譲する。ループバック `::1`・未指定 `::`・ULA `fc00::/7`・リンクローカル
// `fe80::/10` を遮断する。入力は net.isIP===6 を満たす正規化済み文字列を想定。
function isBlockedV6(ip: string): boolean {
  const n = ip.toLowerCase();

  // IPv4-mapped（ドット記法）: ::ffff:127.0.0.1
  const dotted = n.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (dotted) return isBlockedV4(dotted[1]);
  // IPv4-mapped（16進記法）: ::ffff:7f00:1
  const hex = n.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    const v4 = `${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`;
    return isBlockedV4(v4);
  }

  if (n === "::1" || n === "::") return true; // ループバック / 未指定
  if (n.startsWith("fc") || n.startsWith("fd")) return true; // ULA fc00::/7
  if (/^fe[89ab]/.test(n)) return true; // リンクローカル fe80::/10（fe80–febf）
  return false;
}

// 解決後 IP（IPv4 / IPv6）が SSRF ブロック対象か判定する純粋関数（#130）。
// net.isIP で系統を判定し、解析不能な文字列は安全側で遮断する。
export function isSsrfBlocked(ip: string): boolean {
  const v = net.isIP(ip);
  if (v === 4) return isBlockedV4(ip);
  if (v === 6) return isBlockedV6(ip);
  return true; // 解析不能は安全側で遮断
}

// 解決済みアドレス配列のうち、最初にブロック対象となる IP を返す純粋関数（#129）。
// 1 つでもブロック対象があれば（dual-stack の AAAA など）それを返し、無ければ null。
// connect.lookup フック（IP ピン留め）と DNS 全件検査（assertSsrfAllowed）で共有する。
export function firstBlockedAddress(
  addresses: { address: string }[]
): string | null {
  for (const a of addresses) {
    if (isSsrfBlocked(a.address)) return a.address;
  }
  return null;
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
// 傍受からも再利用するため公開する（#69）。解決しうる全アドレス（A / AAAA）を
// 検査し、1 つでもブロック対象なら遮断する（#130）。
export async function assertSsrfAllowed(url: string): Promise<void> {
  const parsed = new URL(url);
  const addresses = await dns.lookup(parsed.hostname, {
    all: true,
    verbatim: true,
  });
  const blocked = firstBlockedAddress(addresses);
  if (blocked) {
    throw new SsrfBlockedError(blocked);
  }
}

// connect.lookup の判定中心部（純粋関数・#129）。接続時に解決されたアドレス配列と、
// Node/undici が要求する形式（Happy Eyeblls の all フラグ）から、コールバックへ渡すべき
// 結果を決める。1 つでもブロック対象があれば blocked を返す（事前検査を通過していても、
// リバインディングで応答 IP がすり替わればここで遮断される）。空配列は解決失敗。
export type SsrfLookupDecision =
  | { kind: "blocked"; address: string }
  | { kind: "empty" }
  | { kind: "all"; addresses: { address: string; family: number }[] }
  | { kind: "single"; address: string; family: number };

export function decideSsrfLookup(
  addresses: { address: string; family: number }[],
  wantsAll: boolean
): SsrfLookupDecision {
  const blocked = firstBlockedAddress(addresses);
  if (blocked) return { kind: "blocked", address: blocked };
  if (addresses.length === 0) return { kind: "empty" };
  if (wantsAll) return { kind: "all", addresses };
  const first = addresses[0];
  return { kind: "single", address: first.address, family: first.family };
}

// DNS リバインディング / TOCTOU 対策の dispatcher（#129）。
// connect.lookup フックで名前解決を 1 回に統一し、解決した全アドレスを検査したうえで、
// 検査に通ったアドレスだけを接続候補として返す（ピン留め）。これにより「検査した IP」と
// 「接続する IP」が必ず一致し、検査後に応答 IP を変えるリバインディングが成立しない。
// TLS の servername（SNI）は元のホスト名が使われるため証明書検証は維持される。
// Node の net/tls は Happy Eyeballs で lookup に `all: true` を渡し、コールバックへ
// `{ address, family }[]` の配列を要求する。その場合は検査済み全件を返し（全件が安全）、
// `all` 無し時のみ単一アドレス形式で返す。1 つでもブロック対象なら接続前に遮断する。
// 仕様: docs/spec/features/proxy.md §DNS リバインディング / TOCTOU 対策（IP ピン留め）
const ssrfSafeAgent = new Agent({
  connect: {
    lookup: (hostname, options, callback) => {
      dnsLookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
        if (err) return callback(err, "", 0);
        const list = addresses as { address: string; family: number }[];
        const wantsAll = !!(options && (options as { all?: boolean }).all);
        const decision = decideSsrfLookup(list, wantsAll);
        switch (decision.kind) {
          case "blocked":
            return callback(new SsrfBlockedError(decision.address), "", 0);
          case "empty":
            return callback(new Error("ENOTFOUND"), "", 0);
          case "all":
            // 検査済みアドレスをそのまま接続に使う（再解決しない）＝ピン留め。
            return (callback as (e: unknown, a: typeof list) => void)(
              null,
              decision.addresses
            );
          case "single":
            return callback(null, decision.address, decision.family);
        }
      });
    },
  },
});

// fetch 失敗の cause 連鎖から SsrfBlockedError を取り出す（#129）。
// undici は connect.lookup の例外を TypeError("fetch failed") の cause に包むため、
// 数段たどってピン留め検査由来の SSRF ブロックを 403 として識別できるようにする。
export function findSsrfCause(err: unknown): SsrfBlockedError | null {
  let cur: unknown = err;
  for (let i = 0; i < 5 && cur; i++) {
    if (cur instanceof SsrfBlockedError) return cur;
    cur = (cur as { cause?: unknown }).cause;
  }
  return null;
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
      // dispatcher は undici の Agent（connect.lookup で IP ピン留め・#129）。
      // Node の fetch 型に dispatcher が無いため init を拡張型でキャストする。
      const init = {
        method,
        headers,
        body: body as BodyInit | undefined,
        ...(duplex ? { duplex } : {}),
        redirect: "manual" as const,
        signal,
        dispatcher: ssrfSafeAgent,
      };
      res = await fetch(currentUrl, init as unknown as RequestInit);
    } catch (err) {
      // ピン留め検査由来の SSRF ブロックは 403 として扱うため伝播させる（#129）。
      const ssrf = findSsrfCause(err);
      if (ssrf) throw ssrf;
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
