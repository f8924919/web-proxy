// ブラウザバック中継（browser-backed fetch）。
// 特定サイトの /browse GET だけ、初回ナビゲーションをヘッドレスブラウザ（インプロセス
// Playwright）で実行し、JS 解決後の DOM を proxyFetch と同じ {response, finalUrl} 契約で返す。
// あわせてブラウザが取得した Cookie を Set-Cookie 化して返す（セッションウォーミング）。
// 仕様: docs/spec/features/proxy.md §ブラウザバック中継（browser-backed fetch）
// 対応 Issue: #69
import type { Browser, BrowserContext } from "playwright";
import {
  assertSsrfAllowed,
  firstBlockedAddress,
  DEFAULT_USER_AGENT,
  BodyTooLargeError,
  maxBufferBytesFromEnv,
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

// ブラウザ実行基盤（バックエンド）。自前 Chromium をインプロセス起動するか、
// 外部ブラウザサービスへ CDP 接続するかを表す。インターフェース契約は不変で、
// getBrowser() の起動方法だけがこれで切り替わる（#71）。
export type BrowserBackend =
  | { mode: "launch" }
  | { mode: "cdp"; endpoint: string };

// 環境変数からブラウザ実行基盤を決める。PROXY_BROWSER_CDP_URL が非空なら外部サービスへ
// connectOverCDP（cdp）、未設定・空白のみなら自前 Chromium 起動（launch・既定）。
// 仕様: docs/spec/features/proxy.md §ブラウザ実行基盤（バックエンドの差し替え・#71）
export function browserBackendFromEnv(
  env: Record<string, string | undefined> = process.env
): BrowserBackend {
  const endpoint = env.PROXY_BROWSER_CDP_URL?.trim();
  if (endpoint) return { mode: "cdp", endpoint };
  return { mode: "launch" };
}

// 自前ブラウザの上流プロキシ設定（residential / クリーン IP を通す・#73）。
export interface BrowserProxyConfig {
  server: string;
  username?: string;
  password?: string;
}

// 環境変数から上流プロキシ設定を組み立てる。PROXY_BROWSER_PROXY_SERVER が空なら
// undefined（プロキシ無し＝サーバー IP で直アクセス・既定挙動）。username/password は
// 非空のときのみ含める。
// 仕様: docs/spec/features/proxy.md §アンチボット対策（egress IP / stealth・#73）
export function browserProxyFromEnv(
  env: Record<string, string | undefined> = process.env
): BrowserProxyConfig | undefined {
  const server = env.PROXY_BROWSER_PROXY_SERVER?.trim();
  if (!server) return undefined;
  const config: BrowserProxyConfig = { server };
  const username = env.PROXY_BROWSER_PROXY_USERNAME?.trim();
  if (username) config.username = username;
  const password = env.PROXY_BROWSER_PROXY_PASSWORD;
  if (password) config.password = password;
  return config;
}

// ヘッドレス検出回避の最小対策（#73）。突破は保証しない。網羅的 stealth は外部サービスに委ねる。
// 自前 chromium.launch() に渡す Chrome フラグ（CDP 接続時は外部サービス側に委譲）。
export const STEALTH_LAUNCH_ARGS = [
  "--disable-blink-features=AutomationControlled",
];

// 全 context へ注入し、ページのスクリプト実行前に navigator.webdriver を隠す init script。
export const STEALTH_INIT_SCRIPT =
  "Object.defineProperty(navigator,'webdriver',{get:()=>undefined});";

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
// （呼び出し側の cookieJar.store が origin 別に保持する・#151 Phase 1）。Path / Secure /
// HttpOnly / SameSite と、永続 cookie の Expires を反映する。
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

// page.content() は DOM のテキストノードのみをシリアライズし、CSSOM（insertRule）で注入された
// CSS や adoptedStyleSheets を出力しない。CSS-in-JS（emotion/styled-components 等の本番 "speedy"
// モード）を使うサイト（例 news.yahoo.co.jp）はクライアントで CSS を CSSOM に直接注入し <style> の
// テキストを空にするため、そのまま取得するとサイト全体の CSS が欠落しレイアウトが崩れる（#120）。
// これを防ぐため、page.content() の直前にブラウザ context で本関数を実行し、CSSOM 上の CSS を
// DOM テキストへ実体化する。page.evaluate がシリアライズして実行するため、外部参照を持たず DOM
// グローバルのみで完結させる（doc 引数の既定値はブラウザの document）。
// 仕様: docs/spec/features/proxy.md §browserFetch の振る舞い（CSSOM スタイルの実体化）
export function inlineCssomStyles(doc: Document = document): void {
  // 1) 空テキストだが CSSOM ルールを持つ <style> を実体化する。
  for (const el of Array.from(doc.querySelectorAll("style"))) {
    let sheet: CSSStyleSheet | null;
    try {
      sheet = el.sheet;
    } catch {
      sheet = null;
    }
    if (!sheet) continue;
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules; // cross-origin 等は SecurityError を投げる
    } catch {
      continue;
    }
    if (rules.length === 0) continue;
    const text = Array.from(rules)
      .map((r) => r.cssText)
      .join("");
    // 既存テキストより CSSOM ルールが多い場合のみ書き戻す（冪等）。
    if (text.length > el.textContent.length) el.textContent = text;
  }

  // 2) adoptedStyleSheets（構築済みスタイルシート）を <style> として <head> へ出力する。
  const adopted = doc.adoptedStyleSheets ?? [];
  for (const sheet of adopted) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      continue;
    }
    if (rules.length === 0) continue;
    const text = Array.from(rules)
      .map((r) => r.cssText)
      .join("");
    if (!text) continue;
    const s = doc.createElement("style");
    s.setAttribute("data-proxy-adopted", "");
    s.textContent = text;
    (doc.head ?? doc.documentElement).appendChild(s);
  }
}

// 描画済み DOM の UTF-8 バイト数を概算する（#144）。page.content() で Node ヒープへ全量
// 転送する前に page.evaluate でブラウザ context 内で測り、上限超過なら取得を打ち切るために使う。
// 文字列長（UTF-16 コード単位数）ではなくバイト数で測り、#134（PROXY_MAX_BUFFER_BYTES）の
// バイト基準と揃える（マルチバイト文字を過小評価しないため）。
// inlineCssomStyles と同じく page.evaluate で実行するため、doc 既定値はブラウザの document。
export function measureDomByteLength(doc: Document = document): number {
  return new TextEncoder().encode(doc.documentElement.outerHTML).length;
}

// 概算 DOM バイト数が上限を超えるか判定する純粋関数（#144）。readTextWithLimit と同じく
// 「>（厳密超過）」で判定し、上限ちょうどは許可する。
export function domSizeExceedsLimit(
  byteLength: number,
  maxBytes: number
): boolean {
  return byteLength > maxBytes;
}

// ===== ランタイム配線（I/O・テスト対象外） =====

// プロセス内で 1 つのブラウザを再利用する（起動コスト削減）。
let sharedBrowser: Browser | null = null;
let launching: Promise<Browser> | null = null;

async function getBrowser(): Promise<Browser> {
  if (sharedBrowser?.isConnected()) return sharedBrowser;
  if (!launching) {
    // Playwright は遅延ロード（ティアが使われない限り読み込まない）。
    // バックエンド（#71）: PROXY_BROWSER_CDP_URL があれば外部サービスへ connectOverCDP、
    // 無ければ自前 Chromium をインプロセス起動する。呼び出し側は不変。
    const backend = browserBackendFromEnv();
    // 自前 launch のみ stealth フラグと上流プロキシ（クリーン IP）を適用する（#73）。
    // CDP 接続は外部サービス側の stealth / IP プールに委ねる。
    const proxy = browserProxyFromEnv();
    launching = import("playwright").then(({ chromium }) =>
      backend.mode === "cdp"
        ? chromium.connectOverCDP(backend.endpoint)
        : chromium.launch({
            args: STEALTH_LAUNCH_ARGS,
            ...(proxy ? { proxy } : {}),
          })
    );
  }
  const browser = await launching;
  launching = null;
  sharedBrowser = browser;
  // 切断時（外部 CDP の idle 切断・自前のクラッシュ等）は共有参照を捨て、
  // 次回呼び出しで再接続・再起動させる（stale 参照・リーク防止）。
  browser.once("disconnected", () => {
    if (sharedBrowser === browser) sharedBrowser = null;
  });
  return browser;
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
      // 解決しうる全アドレス（A / AAAA）を検査する（IPv4 / IPv6 両対応・#130）。
      // ただし Chromium は接続時に自前で再解決するため IP ピン留めはできず、
      // リバインディングの残存窓がある（#129。docs/spec/features/proxy.md §SSRF（不弱化））。
      const addresses = await dns.lookup(hostname, {
        all: true,
        verbatim: true,
      });
      if (firstBlockedAddress(addresses)) {
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
    // ヘッドレス検出回避の最小対策（#73）。launch / CDP の両バックエンドに適用する。
    await context.addInitScript(STEALTH_INIT_SCRIPT);
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
    // page.content() の前に CSSOM 注入 CSS / adoptedStyleSheets を DOM へ実体化する（#120）。
    // CSS-in-JS サイトで CSS が欠落しレイアウトが崩れるのを防ぐ。失敗しても DOM 取得は続行する。
    // page.evaluate は関数ソースをシリアライズしてブラウザ context で実行するため、自己完結した
    // inlineCssomStyles の参照を直接渡す（ラッパー () => inlineCssomStyles() は閉包参照を解決できず
    // ブラウザ側で ReferenceError になる）。引数なし呼び出しで doc は既定の document を使う。
    await page.evaluate(inlineCssomStyles as () => void).catch(() => {});

    // page.content() で描画済み DOM を Node ヒープへ全量転送する前に、ブラウザ context 内で
    // DOM の UTF-8 バイト数を概算し、上限（#134 と同じ PROXY_MAX_BUFFER_BYTES）超過なら
    // 取得を打ち切る（#144）。readTextWithLimit は page.content() 後の Node 側文字列にしか
    // 効かず、ブラウザティアではメモリ常駐が「手遅れ」になるため。測定が失敗したら 0（上限内）
    // とみなして続行し、後段の readTextWithLimit を安全網に残す（ベストエフォート）。
    const domByteLength = await page
      .evaluate(measureDomByteLength as () => number)
      .catch(() => 0);
    if (domSizeExceedsLimit(domByteLength, maxBufferBytesFromEnv())) {
      throw new BodyTooLargeError();
    }

    const html = await page.content();

    // ブラウザの cookie jar を Set-Cookie 化して返す（呼び出し側が cookieJar へ取り込む・#151 Phase 1）。
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
