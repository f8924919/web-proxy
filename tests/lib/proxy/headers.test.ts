/** @jest-environment node */
// 仕様: docs/spec/features/proxy.md §レスポンスヘッダー処理 / §Cookie 処理

import { sanitizeHeaders, sanitizeSetCookie } from "@/lib/proxy/headers";

describe("sanitizeHeaders", () => {
  const BLOCKED = [
    "content-security-policy",
    "x-frame-options",
    "content-encoding",
    "transfer-encoding",
  ];

  test.each(BLOCKED)("%s ヘッダーを除去する", (name) => {
    const headers = new Headers({ [name]: "some-value", "content-type": "text/html" });
    const result = sanitizeHeaders(headers);
    expect(result.has(name)).toBe(false);
  });

  test("content-type はそのまま維持する", () => {
    const headers = new Headers({ "content-type": "text/html; charset=utf-8" });
    const result = sanitizeHeaders(headers);
    expect(result.get("content-type")).toBe("text/html; charset=utf-8");
  });

  test("cache-control はそのまま維持する", () => {
    const headers = new Headers({ "cache-control": "max-age=3600" });
    const result = sanitizeHeaders(headers);
    expect(result.get("cache-control")).toBe("max-age=3600");
  });
});

describe("sanitizeSetCookie", () => {
  test("Domain 属性を除去する", () => {
    const value = "session=abc; Path=/; Domain=example.com; HttpOnly";
    expect(sanitizeSetCookie(value)).toBe("session=abc; Path=/; HttpOnly");
  });

  test("Domain 属性がない場合はそのまま返す", () => {
    const value = "session=abc; Path=/; HttpOnly";
    expect(sanitizeSetCookie(value)).toBe("session=abc; Path=/; HttpOnly");
  });

  test("Secure / SameSite はそのまま維持する", () => {
    const value = "token=xyz; Path=/; Domain=example.com; Secure; SameSite=Strict";
    expect(sanitizeSetCookie(value)).toBe("token=xyz; Path=/; Secure; SameSite=Strict");
  });
});
