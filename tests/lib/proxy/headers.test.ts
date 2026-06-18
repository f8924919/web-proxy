/** @jest-environment node */
// 仕様: docs/spec/features/proxy.md §レスポンスヘッダー処理 / §認証情報の転送

import {
  sanitizeHeaders,
  sanitizeSetCookie,
  forwardableRequestHeaders,
} from "@/lib/proxy/headers";

describe("sanitizeHeaders", () => {
  const BLOCKED = [
    "content-security-policy",
    "x-frame-options",
    "content-encoding",
    "transfer-encoding",
    "speculation-rules",
  ];

  test.each(BLOCKED)("%s ヘッダーを除去する", (name) => {
    const headers = new Headers({
      [name]: "some-value",
      "content-type": "text/html",
    });
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
    const value =
      "token=xyz; Path=/; Domain=example.com; Secure; SameSite=Strict";
    expect(sanitizeSetCookie(value)).toBe(
      "token=xyz; Path=/; Secure; SameSite=Strict"
    );
  });
});

describe("forwardableRequestHeaders", () => {
  test("Cookie と Authorization を転送対象として抽出する", () => {
    const headers = new Headers({
      cookie: "session=abc",
      authorization: "Bearer xyz",
    });
    expect(forwardableRequestHeaders(headers)).toEqual({
      cookie: "session=abc",
      authorization: "Bearer xyz",
    });
  });

  test("存在しない認証ヘッダーは含めない（無ければ空オブジェクト）", () => {
    const headers = new Headers({ "user-agent": "test" });
    expect(forwardableRequestHeaders(headers)).toEqual({});
  });

  test("許可リスト外のヘッダーは転送しない", () => {
    const headers = new Headers({
      cookie: "session=abc",
      "x-secret": "leak",
      "user-agent": "test",
    });
    const result = forwardableRequestHeaders(headers);
    expect(result).toEqual({ cookie: "session=abc" });
  });
});
