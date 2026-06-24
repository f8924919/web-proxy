// 仕様: docs/spec/features/proxy.md §認証 / 接続元許可制（任意・#148）
//
// オープンプロキシを制限環境で運用したい場合に限り有効化できる、任意の共有トークン認証。
// PROXY_AUTH_TOKEN を設定したときのみ全中継経路（/browse・/api/proxy）で認証を要求する。
// 未設定・空白のみは無効（オープン）で後方互換。本モジュールは純粋関数で構成し、NextRequest
// 依存のグルーは呼び出し側（browseGuards / relayAsset / /unlock ルート）に置く。

// トークン受け渡しに使う Cookie 名・ヘッダー名。Cookie 名は中継先 Cookie のスコープ接頭辞
// "__pxy."（headers.ts）と一致しないため、scopedCookieHeader でターゲットへ転送されない。
export const AUTH_COOKIE_NAME = "__pxy_auth";
export const AUTH_HEADER_NAME = "x-proxy-token";

export interface ProxyAuthConfig {
  token: string;
}

// env から共有トークン設定を読む純粋関数（clientIp.ts 等の *FromEnv パターンに倣う）。
// PROXY_AUTH_TOKEN を trim し、空でなければ { token } を返す。未設定・空白のみは null
// （＝認証無効・オープン）で後方互換。
export function proxyAuthConfigFromEnv(
  env: Record<string, string | undefined> = process.env
): ProxyAuthConfig | null {
  const token = env.PROXY_AUTH_TOKEN?.trim();
  return token ? { token } : null;
}

// 提示トークンと期待トークンの定数時間比較。タイミング攻撃を避けるため長さが違っても
// 早期 return せず全長を走査する。presented が null なら false。
export function tokensMatch(
  presented: string | null,
  expected: string
): boolean {
  if (presented === null) return false;
  let diff = presented.length ^ expected.length;
  for (let i = 0; i < presented.length; i++) {
    // expected の範囲外は 0 と XOR（長さ差は上の diff に既に反映済み）。
    diff |= presented.charCodeAt(i) ^ (expected.charCodeAt(i) || 0);
  }
  return diff === 0;
}

// Cookie ヘッダー値から指定名の Cookie 値を取り出す純粋関数。前後空白を無視し、
// 値に "=" を含む場合は先頭の "=" で分割する。該当なし・null は null。
export function parseCookieValue(
  cookieHeader: string | null,
  name: string
): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    if (trimmed.slice(0, eq).trim() === name) {
      return trimmed.slice(eq + 1).trim();
    }
  }
  return null;
}

// 提示トークンを取り出す純粋関数。X-Proxy-Token ヘッダー（優先）→ __pxy_auth Cookie の順。
// どちらも空・無しなら null。
export function presentedToken(
  headerValue: string | null,
  cookieHeader: string | null
): string | null {
  const fromHeader = headerValue?.trim();
  if (fromHeader) return fromHeader;
  const fromCookie = parseCookieValue(cookieHeader, AUTH_COOKIE_NAME);
  return fromCookie || null;
}

// 認証可否を判定する純粋関数。config が null（無効）なら常に true。有効なら提示トークンと
// config.token を定数時間比較する。
export function isAuthorized(
  headerValue: string | null,
  cookieHeader: string | null,
  config: ProxyAuthConfig | null
): boolean {
  if (config === null) return true;
  return tokensMatch(presentedToken(headerValue, cookieHeader), config.token);
}

// 認証 Cookie の Set-Cookie 値を組み立てる純粋関数。HttpOnly / SameSite=Lax を付け、
// Path は BASE_PATH（あれば）にスコープする。Secure は TLS 終端構成（アプリは http で
// 受ける）を壊さないため付けない（盗聴対策はトランスポート層の責務）。
export function buildAuthCookie(token: string, basePath: string): string {
  const path = basePath || "/";
  return `${AUTH_COOKIE_NAME}=${token}; HttpOnly; SameSite=Lax; Path=${path}`;
}

// 解錠後の戻り先を検証する純粋関数（オープンリダイレクト防止）。"/" 始まりのアプリ相対
// パスのみ通し、それ以外は ${basePath}/ へフォールバックする。2 文字目が "/" または "\"
// のものは弾く: "//host" はプロトコル相対の絶対 URL、"/\host" もブラウザが "//host" に
// 正規化して外部オリジンへ誘導され得るため（バックスラッシュ・バイパス対策）。
export function safeRedirectPath(raw: string | null, basePath: string): string {
  const fallback = `${basePath || ""}/`;
  if (!raw) return fallback;
  if (!raw.startsWith("/") || raw[1] === "/" || raw[1] === "\\") return fallback;
  return raw;
}

// HTML 属性値のエスケープ（最小限）。
function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// トークン入力フォーム付きの解錠ページ HTML を組み立てる純粋関数。フォームは
// POST {basePath}/unlock（ブラウザ送信 URL のため BASE_PATH を前置）、隠しフィールドに
// redirect（アプリ相対・BASE_PATH なし）を持つ。opts.error で不一致メッセージを表示する。
export function unlockHtml(
  redirectTo: string,
  basePath: string,
  opts: { error?: boolean } = {}
): string {
  const action = `${basePath || ""}/unlock`;
  const errorBlock = opts.error
    ? `<p style="color:#c00">トークンが正しくありません。</p>`
    : "";
  return `<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>認証が必要です</title></head>
<body style="font-family:sans-serif;padding:2rem;max-width:420px;margin:0 auto">
<h2>認証が必要です</h2>
<p>このプロキシはアクセストークンが必要です。配布されたトークンを入力してください。</p>
${errorBlock}
<form method="POST" action="${escapeAttr(action)}" style="display:flex;flex-direction:column;gap:12px">
<input type="hidden" name="redirect" value="${escapeAttr(redirectTo)}">
<input type="password" name="token" placeholder="アクセストークン" autofocus
 style="padding:8px;font-size:16px;border:1px solid #ccc;border-radius:4px">
<button type="submit" style="padding:8px;font-size:16px;cursor:pointer">送信</button>
</form>
</body></html>`;
}
