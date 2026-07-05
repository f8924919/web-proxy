// RBI（Remote Browser Isolation）フォールバック判定 — 第三ティア（#193）。
// 中継（proxyFetch）→ ブラウザ（browserFetch）→ RBI の三層エスカレーションの最上段。
// 設計の正本: docs/arch/proxy.md §src/lib/proxy/rbi.ts。
// 現状は設計案＋モック PoC の範囲（relayBrowse への配線・実バックエンドは本採用タスク）。

import { parseBrowserHosts, shouldUseBrowser } from "./browserFetch";
import { shouldPromoteToBrowser } from "./promotion";

export type RbiBackendKind = "off" | "mock" | "kasm" | "neko";

export interface RbiConfig {
  backend: RbiBackendKind;
  baseUrl?: string;
  forceHosts: string[];
  maxSessions: number;
  sessionTtlMs: number;
}

const DEFAULT_MAX_SESSIONS = 5;
const DEFAULT_SESSION_TTL_MS = 15 * 60 * 1000;
const MOCK_DEFAULT_BASE_URL = "https://rbi.mock.invalid";

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

// 環境変数から RBI 設定を組み立てる。RBI_BACKEND が未設定・不正値なら off。
// kasm / neko は RBI_BASE_URL 必須（無ければ off へフォールバック・安全側）。
// mock はローカル完結のため RBI_BASE_URL 省略可（既定 URL を持つ）。
export function rbiBackendFromEnv(
  env: Record<string, string | undefined> = process.env
): RbiConfig {
  const raw = env.RBI_BACKEND?.toLowerCase();
  const baseUrl = env.RBI_BASE_URL?.trim() || undefined;
  let backend: RbiBackendKind = "off";
  if (raw === "mock") backend = "mock";
  else if ((raw === "kasm" || raw === "neko") && baseUrl) backend = raw;
  return {
    backend,
    baseUrl: backend === "mock" ? (baseUrl ?? MOCK_DEFAULT_BASE_URL) : baseUrl,
    forceHosts: parseBrowserHosts(env.RBI_FORCE_HOSTS),
    maxSessions: parsePositiveInt(env.RBI_MAX_SESSIONS, DEFAULT_MAX_SESSIONS),
    sessionTtlMs: parsePositiveInt(
      env.RBI_SESSION_TTL_MS,
      DEFAULT_SESSION_TTL_MS
    ),
  };
}

// allowlist（RBI_FORCE_HOSTS）判定。shouldUseBrowser のホスト接尾辞一致をそのまま再利用する。
export function shouldUseRbi(url: string, config: RbiConfig): boolean {
  if (config.backend === "off") return false;
  return shouldUseBrowser(url, {
    mode: config.forceHosts.length > 0 ? "allowlist" : "off",
    hosts: config.forceHosts,
  });
}

// ブラウザティアの出力（昇格後もチャレンジ / 崩れが解消しないか）を再判定する。
// 判定ロジックは新設せず shouldPromoteToBrowser を再利用。真なら egress IP 起因
// ブロックの疑い（#73 接合点）として RBI 昇格候補になる。
export interface BrowserTierResult {
  html: string;
  status: number;
  contentType: string | null;
}

export function shouldPromoteToRbi(
  result: BrowserTierResult,
  config: RbiConfig
): boolean {
  if (config.backend === "off") return false;
  return shouldPromoteToBrowser(result.html, result.status, result.contentType);
}

// ===== 再昇格抑止（PromotionGuard と同型・インメモリ状態） =====

const DEFAULT_GUARD_WINDOW_MS = 60_000;

// 同一 URL（host+path 単位・クエリ無視）の RBI 昇格を短時間ウィンドウ内で 1 回に制限する。
// インメモリ前提（複数インスタンスでは共有されない。docs/arch/proxy.md の既知の制約）。
export class RbiGuard {
  private store = new Map<string, number[]>();

  constructor(private readonly windowMs: number = DEFAULT_GUARD_WINDOW_MS) {}

  tryPromote(target: URL): boolean {
    const now = Date.now();
    const cutoff = now - this.windowMs;
    const key = `${target.host}${target.pathname}`;

    const recent = (this.store.get(key) ?? []).filter((t) => t > cutoff);
    if (recent.length > 0) {
      this.store.set(key, recent);
      return false;
    }
    recent.push(now);
    this.store.set(key, recent);
    return true;
  }
}

// ===== 同時セッション数上限（ConcurrencyLimiter と同型の acquire/release） =====

// RBI セッションは常駐するため、ウィンドウ方式でなく生カウンタで上限を守る。
// tryAcquire は空きがあれば release 関数（冪等）を返し、上限到達時は null。
export class RbiSessionLimiter {
  private active = 0;

  constructor(private readonly maxSessions: number) {}

  tryAcquire(): (() => void) | null {
    if (this.active >= this.maxSessions) return null;
    this.active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
    };
  }
}

// ===== セッション仲介契約（RbiBackend）とモック実装（PoC） =====

export interface CookieSeed {
  name: string;
  value: string;
  domain: string;
  path?: string;
}

// RBI バックエンドのセッション仲介契約。誘導方式（302 / iframe）に依存しない。
// 呼び出し側は createSession の前に assertSsrfAllowed(targetUrl) を必須とする
// （設計要件。docs/arch/proxy.md §セキュリティ要件）。
export interface RbiBackend {
  createSession(
    targetUrl: string,
    seedCookies?: CookieSeed[]
  ): Promise<{ sessionId: string; sessionUrl: string }>;
  destroySession(sessionId: string): Promise<void>;
}

// PoC 用モック。RBI_BASE_URL と同一オリジンの推測不能な sessionUrl を返す
// （ケーパビリティ URL 要件の最小充足）。実バックエンド（Kasm API / Neko
// コンテナプール）は本採用タスクで実装する。
export class MockRbiBackend implements RbiBackend {
  private sessions = new Set<string>();

  constructor(private readonly baseUrl: string) {}

  async createSession(
    _targetUrl: string,
    _seedCookies?: CookieSeed[]
  ): Promise<{ sessionId: string; sessionUrl: string }> {
    const sessionId = crypto.randomUUID().replaceAll("-", "");
    this.sessions.add(sessionId);
    const sessionUrl = new URL(`/session/${sessionId}`, this.baseUrl).href;
    return { sessionId, sessionUrl };
  }

  async destroySession(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
  }

  activeSessionCount(): number {
    return this.sessions.size;
  }
}
