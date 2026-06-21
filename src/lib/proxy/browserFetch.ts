// ブラウザバック中継（browser-backed fetch）。
// 特定サイトの /browse GET だけ、初回ナビゲーションをヘッドレスブラウザ（インプロセス
// Playwright）で実行し、JS 解決後の DOM を proxyFetch と同じ {response, finalUrl} 契約で返す。
// あわせてブラウザが取得した Cookie を Set-Cookie 化して返す（セッションウォーミング）。
// 仕様: docs/spec/features/proxy.md §ブラウザバック中継（browser-backed fetch）
// 対応 Issue: #69
import type { Browser, BrowserContext } from "playwright";
import {
  assertSsrfAllowed,
  isSsrfBlocked,
  DEFAULT_USER_AGENT,
  type ProxyFetchResult,
  type ProxyRequestOptions,
} from "./fetch";

// ===== 純粋関数（テスト対象） =====

export type BrowserTierMode = "off" | "allowlist" | "on";

export interface BrowserTierConfig {
  mode: BrowserTierMode;
  hosts: string[];
}

// PROXY_BROWSER_HOSTS（カンマ区切り）を正規化したホスト接尾辞配列にする。
// 前後空白除去・小文字化・先頭ドット除去・空要素の除外を行う。
export function parseBrowserHosts(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((h) => h.trim().toLowerCase().replace(/^\./, ""))
    .filter((h) => h.length > 0);
}

// 環境変数からティアコンフィグを組み立てる。MODE が未設定・不正値のときは、
// HOSTS が非空なら allowlist、空なら off にフォールバックする。
export function browserTierConfigFromEnv(
  env: Record<string, string | undefined> = process.env
): BrowserTierConfig {
  const hosts = parseBrowserHosts(env.PROXY_BROWSER_HOSTS);
  const raw = env.PROXY_BROWSER_MODE?.toLowerCase();
  const mode: BrowserTierMode =
    raw === "on" || raw === "allowlist" || raw === "off"
      ? raw
      : hosts.length > 0
        ? "allowlist"
        : "off";
  return { mode, hosts };
}

// URL とコンフィグからブラウザティアを使うか判定する。
// off→常に false / on→常に true / allowlist→ホスト接尾辞一致時のみ true。
// URL が不正なら false（安全側）。
export function shouldUseBrowser(
  url: string,
  config: BrowserTierConfig
): boolean {
  if (config.mode === "off") return false;
  if (config.mode === "on") return true;
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return config.hosts.some(
    (suffix) => host === suffix || host.endsWith("." + suffix)
  );
}

export type BrowserWaitUntil =
  | "load"
  | "domcontentloaded"
  | "networkidle"
  | "commit";

export interface BrowserWaitConfig {
  waitUntil: BrowserWaitUntil;
  timeoutMs: number;
  settleMs: number;
}

const VALID_WAIT_UNTIL: BrowserWaitUntil[] = [
  "load",
  "domcontentloaded",
  "networkidle",
  "commit",
];

// 非負ミリ秒の env を読む。非数値・負値は既定へフォールバックする
// （debug-browser.mjs の readMs と同方針、#39）。
function readMs(raw: string | undefined, fallback: number): number {
  if (raw == null || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

// page.goto の待機戦略・タイムアウトと追加 idle 待ちを env から解決する。
// 不正値は既定へフォールバックする。
export function resolveBrowserWaitConfig(
  env: Record<string, string | undefined> = process.env
): BrowserWaitConfig {
  const rawWait = env.PROXY_BROWSER_WAIT_UNTIL;
  const waitUntil = VALID_WAIT_UNTIL.includes(rawWait as BrowserWaitUntil)
    ? (rawWait as BrowserWaitUntil)
    : "load";
  return {
    waitUntil,
    timeoutMs: readMs(env.PROXY_BROWSER_TIMEOUT_MS, 15000),
    settleMs: readMs(env.PROXY_BROWSER_SETTLE_MS, 1500),
  };
}

export interface BrowserCookie {
  name: string;
  value: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
  /** unix 秒。-1 はセッション cookie（Expires を付けない）。 */
  expires?: number;
}

// Playwright の cookie を Set-Cookie 文字列へ変換する。Domain は付けない
// （sanitizeSetCookie がスコープ化する）。Path / Secure / HttpOnly / SameSite と、
// 永続 cookie の Expires を反映する。
export function cookieToSetCookie(cookie: BrowserCookie): string {
  const parts = [`${cookie.name}=${cookie.value}`];
  parts.push(`Path=${cookie.path ?? "/"}`);
  if (typeof cookie.expires === "number" && cookie.expires > 0) {
    parts.push(`Expires=${new Date(cookie.expires * 1000).toUTCString()}`);
  }
  if (cookie.secure) parts.push("Secure");
  if (cookie.httpOnly) parts.push("HttpOnly");
  if (cookie.sameSite) parts.push(`SameSite=${cookie.sameSite}`);
  return parts.join("; ");
}

// ===== ランタイム配線（I/O・テスト対象外） =====

// プロセス内で 1 つのブラウザを再利用する（起動コスト削減）。
let sharedBrowser: Browser | null = null;
let launching: Promise<Browser> | null = null;

async function getBrowser(): Promise<Browser> {
  if (sharedBrowser?.isConnected()) return sharedBrowser;
  if (!launching) {
    // Playwright は遅延ロード（ティアが使われない限り読み込まない）。
    launching = import("playwright").then(({ chromium }) => chromium.launch());
  }
  sharedBrowser = await launching;
  launching = null;
  return sharedBrowser;
}

// 同時に起動する context 数を上限で絞る簡易セマフォ。
const MAX_CONCURRENCY = Math.max(
  1,
  readMs(process.env.PROXY_BROWSER_MAX_CONCURRENCY, 2)
);
let active = 0;
const waiters: (() => void)[] = [];

async function acquireSlot(): Promise<void> {
  if (active < MAX_CONCURRENCY) {
    active++;
    return;
  }
  await new Promise<void>((resolve) => waiters.push(resolve));
  active++;
}

function releaseSlot(): void {
  active--;
  const next = waiters.shift();
  if (next) next();
}

// ブラウザの全サブリクエストに SSRF チェックを適用する route ハンドラを仕込む。
// 解決後 IP がブロック対象なら中断する（http(s) のみ対象、それ以外は素通し）。
async function installSsrfGuard(context: BrowserContext): Promise<void> {
  await context.route("**/*", async (route) => {
    const reqUrl = route.request().url();
    let hostname: string;
    try {
      const parsed = new URL(reqUrl);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        await route.continue();
        return;
      }
      hostname = parsed.hostname;
    } catch {
      await route.abort();
      return;
    }
    try {
      const dns = await import("dns/promises");
      const { address } = await dns.lookup(hostname, { family: 4 });
      if (isSsrfBlocked(address)) {
        await route.abort();
        return;
      }
    } catch {
      // 解決失敗は中断（到達不能・不正ホスト）。
      await route.abort();
      return;
    }
    await route.continue();
  });
}

// ブラウザバック中継本体。proxyFetch と同じ {response, finalUrl} を返す。
// 失敗時は呼び出し側（relayBrowse 経由の fetchTarget）が proxyFetch へフォールバックする。
export async function browserFetch(
  url: string,
  options?: ProxyRequestOptions
): Promise<ProxyFetchResult> {
  // 初回ナビゲーション URL の SSRF チェック（中継ティアと同等）。ブロックは伝播させる。
  await assertSsrfAllowed(url);

  await acquireSlot();
  let context: BrowserContext | null = null;
  try {
    const browser = await getBrowser();
    const userAgent = process.env.PROXY_USER_AGENT || DEFAULT_USER_AGENT;
    context = await browser.newContext({
      userAgent,
      // 受信リクエストの Cookie / Authorization 等を初回ナビゲーションへ引き継ぐ。
      extraHTTPHeaders: options?.headers ?? {},
    });
    await installSsrfGuard(context);

    const page = await context.newPage();
    const { waitUntil, timeoutMs, settleMs } = resolveBrowserWaitConfig();

    let status = 200;
    try {
      const resp = await page.goto(url, { waitUntil, timeout: timeoutMs });
      status = resp?.status() ?? 200;
    } catch {
      // タイムアウト・読み込み失敗でも収集済み DOM をベストエフォートで返す（#39）。
    }
    // JS の落ち着きを待ってから DOM を取る。
    await page.waitForTimeout(settleMs).catch(() => {});

    const finalUrl = page.url();
    const html = await page.content();

    // ブラウザの cookie jar をスコープ化のため Set-Cookie 化して返す。
    const headers = new Headers();
    headers.set("Content-Type", "text/html; charset=utf-8");
    for (const c of await context.cookies()) {
      headers.append("Set-Cookie", cookieToSetCookie(c));
    }

    return {
      response: new Response(html, { status, headers }),
      finalUrl,
    };
  } finally {
    await context?.close().catch(() => {});
    releaseSlot();
  }
}
