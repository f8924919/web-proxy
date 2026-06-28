import { randomUUID } from "crypto";
import { parseCookieValue } from "@/lib/proxy/auth";

// サーバー側 Cookie jar（#151 Phase 1）。中継先の Set-Cookie をクライアントへ返さず、
// セッション（__pxy_sid）× ターゲット origin 別にサーバー側へ保持する。これにより中継
// Cookie が document.cookie に現れなくなり、サイト間アイソレーションの脅威 (a)（server-set
// Cookie 分）を塞ぐ。rateLimit.ts 等と同じく単一プロセス前提・プロセス再起動でリセット・
// 複数インスタンス間では共有されない。
// 仕様: docs/spec/features/proxy.md §サイト間 Cookie アイソレーション

// jar を引くためのセッション ID Cookie 名。廃止した旧スコープ接頭辞 "__pxy." とも
// 認証 cookie "__pxy_auth"（auth.ts）とも非衝突。
export const SESSION_COOKIE_NAME = "__pxy_sid";

// セッションの最終アクセスからの生存期間。これを過ぎたセッションは GC で回収する。
const SESSION_TTL_MS = 30 * 60 * 1000;
// セッション総数の上限。超過時は最終アクセスが最古のものから退避する（メモリ枯渇 DoS 対策）。
const MAX_SESSIONS = 10_000;
// 1 セッション × origin あたりの保持 Cookie 数の上限。
const MAX_COOKIES_PER_ORIGIN = 50;
// GC の最小間隔。store 呼び出し時に間引いて走らせ、毎回の全走査を避ける。
const GC_INTERVAL_MS = 60 * 1000;

export interface SessionRef {
  id: string;
  isNew: boolean;
}

// 不透明なセッション ID を生成する。
export function newSessionId(): string {
  return randomUUID();
}

// __pxy_sid Cookie の Set-Cookie 値を組み立てる純粋関数。buildAuthCookie に倣い
// HttpOnly / SameSite=Lax を付け、Path は BASE_PATH（あれば）にスコープする。Secure は
// TLS 終端構成（アプリは http で受ける）を壊さないため付けない。
export function buildSessionCookie(
  sessionId: string,
  basePath: string
): string {
  const path = basePath || "/";
  return `${SESSION_COOKIE_NAME}=${sessionId}; HttpOnly; SameSite=Lax; Path=${path}`;
}

// 受信 Cookie から __pxy_sid を読み、既存なら { id, isNew:false }、無ければ新規セッションを
// { id, isNew:true } で返す。isNew のときだけ呼び出し側がレスポンスへ buildSessionCookie を
// Set-Cookie する。
export function resolveSession(cookieHeader: string | null): SessionRef {
  const existing = parseCookieValue(cookieHeader, SESSION_COOKIE_NAME);
  if (existing) return { id: existing, isNew: false };
  return { id: newSessionId(), isNew: true };
}

export interface ParsedSetCookie {
  name: string;
  value: string;
  // 絶対失効時刻（epoch ms）。null は明示期限の無いセッション cookie（セッション TTL で失効）。
  expiresAt: number | null;
  // 削除指示（Max-Age<=0 / 過去 Expires）。
  deleted: boolean;
}

// 1 行の Set-Cookie を jar 格納用に解析する純粋関数。Domain は無視し、Max-Age（相対秒）/
// Expires（絶対日時）から expiresAt を算出する。Max-Age は Expires より優先する（RFC 6265）。
// name=value の形でなければ null。
export function parseSetCookie(
  setCookie: string,
  now: number
): ParsedSetCookie | null {
  const parts = setCookie.split(";").map((p) => p.trim());
  const [nameValue, ...attrs] = parts;
  const eq = nameValue.indexOf("=");
  if (eq === -1) return null;
  const name = nameValue.slice(0, eq).trim();
  const value = nameValue.slice(eq + 1).trim();
  if (!name) return null;

  let maxAge: number | null = null;
  let expires: number | null = null;
  for (const attr of attrs) {
    const aeq = attr.indexOf("=");
    const key = (aeq === -1 ? attr : attr.slice(0, aeq)).trim().toLowerCase();
    const v = aeq === -1 ? "" : attr.slice(aeq + 1).trim();
    if (key === "max-age") {
      const sec = Number(v);
      if (Number.isFinite(sec)) maxAge = sec;
    } else if (key === "expires") {
      const t = Date.parse(v);
      if (!Number.isNaN(t)) expires = t;
    }
  }

  let expiresAt: number | null = null;
  let deleted = false;
  // Max-Age が指定されていれば Expires より優先する。
  if (maxAge !== null) {
    if (maxAge <= 0) deleted = true;
    else expiresAt = now + maxAge * 1000;
  } else if (expires !== null) {
    if (expires <= now) deleted = true;
    else expiresAt = expires;
  }

  return { name, value, expiresAt, deleted };
}

interface JarCookie {
  value: string;
  expiresAt: number | null;
}

interface Session {
  // origin → (cookie 名 → エントリ)
  origins: Map<string, Map<string, JarCookie>>;
  lastAccess: number;
}

export class CookieJar {
  private sessions = new Map<string, Session>();
  private lastGc = 0;

  // 上流レスポンスの Set-Cookie 群を格納する。deleted は除去、それ以外は upsert する。
  // setCookies は res.headers.getSetCookie() の配列を渡す。
  store(
    sessionId: string,
    origin: string,
    setCookies: string[],
    now: number = Date.now()
  ): void {
    this.gc(now);
    const session = this.touch(sessionId, now);
    let jar = session.origins.get(origin);
    if (!jar) {
      jar = new Map();
      session.origins.set(origin, jar);
    }
    for (const sc of setCookies) {
      const parsed = parseSetCookie(sc, now);
      if (!parsed) continue;
      if (parsed.deleted) {
        jar.delete(parsed.name);
        continue;
      }
      // 後勝ちで上書きするため、挿入順を最新化する目的で一度削除してから設定する。
      jar.delete(parsed.name);
      jar.set(parsed.name, {
        value: parsed.value,
        expiresAt: parsed.expiresAt,
      });
    }
    this.enforceOriginCap(jar);
    this.enforceSessionCap();
  }

  // 当該セッション × origin の未失効エントリを name=value; … で連結して返す。
  // 無ければ空文字（呼び出し側は Cookie ヘッダーを付けない）。
  cookieHeader(
    sessionId: string,
    origin: string,
    now: number = Date.now()
  ): string {
    const session = this.sessions.get(sessionId);
    if (!session) return "";
    session.lastAccess = now;
    const jar = session.origins.get(origin);
    if (!jar) return "";
    const out: string[] = [];
    for (const [name, cookie] of jar) {
      if (cookie.expiresAt !== null && cookie.expiresAt <= now) {
        jar.delete(name);
        continue;
      }
      out.push(`${name}=${cookie.value}`);
    }
    return out.join("; ");
  }

  private touch(sessionId: string, now: number): Session {
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = { origins: new Map(), lastAccess: now };
      this.sessions.set(sessionId, session);
    }
    session.lastAccess = now;
    return session;
  }

  private enforceOriginCap(jar: Map<string, JarCookie>): void {
    if (jar.size <= MAX_COOKIES_PER_ORIGIN) return;
    // Map は挿入順を保つため、最古から超過分を退避する。
    const excess = jar.size - MAX_COOKIES_PER_ORIGIN;
    let i = 0;
    for (const key of jar.keys()) {
      if (i++ >= excess) break;
      jar.delete(key);
    }
  }

  private enforceSessionCap(): void {
    if (this.sessions.size <= MAX_SESSIONS) return;
    const sorted = [...this.sessions.entries()].sort(
      (a, b) => a[1].lastAccess - b[1].lastAccess
    );
    const excess = this.sessions.size - MAX_SESSIONS;
    for (let i = 0; i < excess; i++) this.sessions.delete(sorted[i][0]);
  }

  private gc(now: number): void {
    if (now - this.lastGc < GC_INTERVAL_MS) return;
    this.lastGc = now;
    for (const [id, session] of this.sessions) {
      if (now - session.lastAccess > SESSION_TTL_MS) this.sessions.delete(id);
    }
  }
}

// 共有インスタンス（rateLimit.ts 等のシングルトン公開に倣う）。
export const cookieJar = new CookieJar();

// undici / Web 標準の Headers から Set-Cookie 群を取り出すユーティリティ。
// getSetCookie() を持たない実装では空配列を返す（fetch のレスポンスは undici のため通常持つ）。
export function setCookiesFromHeaders(headers: Headers): string[] {
  const h = headers as Headers & { getSetCookie?: () => string[] };
  return typeof h.getSetCookie === "function" ? h.getSetCookie() : [];
}
