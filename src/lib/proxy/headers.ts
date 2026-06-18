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
