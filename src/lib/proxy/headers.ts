const BLOCKED_HEADERS = new Set([
  "content-security-policy",
  "x-frame-options",
  "content-encoding",
  "transfer-encoding",
  // ブラウザがページ内 /browse?url=... リンクを prefetch してレート枠を消費するのを防ぐ。
  // 前段 CDN が後段で注入する分はコードからは消せない（docs/spec/features/proxy.md 参照）。
  "speculation-rules",
]);

export function sanitizeHeaders(headers: Headers): Headers {
  const result = new Headers();
  headers.forEach((value, name) => {
    if (!BLOCKED_HEADERS.has(name.toLowerCase())) {
      try {
        if (name.toLowerCase() === "set-cookie") {
          result.append(name, sanitizeSetCookie(value));
        } else {
          result.set(name, value);
        }
      } catch {
        // 不正な値（改行文字など）を含むヘッダーはスキップ
      }
    }
  });
  return result;
}

export function sanitizeSetCookie(value: string): string {
  return value
    .split(";")
    .map((part) => part.trim())
    .filter((part) => !/^domain=/i.test(part))
    .join("; ");
}

// ターゲットへ転送してよいリクエスト認証ヘッダーの許可リスト。
// 全ヘッダー素通しを避け、明示的に限定する。
const FORWARD_REQUEST_HEADERS = ["cookie", "authorization"] as const;

// 受信リクエストの Headers から、転送対象の認証ヘッダー（Cookie / Authorization）を
// 許可リストで抽出する純粋関数。存在するヘッダーのみを含める。
// 各 Route Handler はこの結果を proxyFetch の options.headers へ渡す。
// 仕様: docs/spec/features/proxy.md §認証情報の転送
export function forwardableRequestHeaders(
  incoming: Headers
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of FORWARD_REQUEST_HEADERS) {
    const value = incoming.get(name);
    if (value) result[name] = value;
  }
  return result;
}
