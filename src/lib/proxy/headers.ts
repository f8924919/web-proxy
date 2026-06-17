const BLOCKED_HEADERS = new Set([
  "content-security-policy",
  "x-frame-options",
  "content-encoding",
  "transfer-encoding",
]);

export function sanitizeHeaders(headers: Headers): Headers {
  const result = new Headers();
  headers.forEach((value, name) => {
    if (!BLOCKED_HEADERS.has(name.toLowerCase())) {
      if (name.toLowerCase() === "set-cookie") {
        result.append(name, sanitizeSetCookie(value));
      } else {
        result.set(name, value);
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
