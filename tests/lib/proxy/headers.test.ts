/** @jest-environment node */
// 仕様: docs/spec/features/proxy.md §レスポンスヘッダー処理 / §認証情報の転送 / §サイト間 Cookie アイソレーション / §CORS プリフライト対応

import {
  sanitizeHeaders,
  sanitizeSetCookie,
  cookieScopeKey,
  scopedCookieHeader,
  forwardableRequestHeaders,
  relayRequestHeaders,
  buildCorsPreflightHeaders,
  allowedCorsOrigin,
} from "@/lib/proxy/headers";

const ORIGIN_A = "https://a.example";
const ORIGIN_B = "https://b.example";

// テスト用: ある origin にスコープされた Cookie 文字列（name=value）を組み立てる。
const scoped = (origin: string, name: string, value: string): string =>
  `__pxy.${cookieScopeKey(origin)}.${name}=${value}`;

describe("cookieScopeKey", () => {
  test("URL セーフ文字（base64url）のみ・パディング無しで返す", () => {
    expect(cookieScopeKey(ORIGIN_A)).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  test("同じ origin には同じ鍵を返す（決定的）", () => {
    expect(cookieScopeKey(ORIGIN_A)).toBe(cookieScopeKey(ORIGIN_A));
  });

  test("異なる origin には異なる鍵を返す", () => {
    expect(cookieScopeKey(ORIGIN_A)).not.toBe(cookieScopeKey(ORIGIN_B));
  });

  test("鍵は origin の base64url であり復元できる", () => {
    const key = cookieScopeKey(ORIGIN_A);
    const decoded = atob(key.replace(/-/g, "+").replace(/_/g, "/"));
    expect(decoded).toBe(ORIGIN_A);
  });
});

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
    const result = sanitizeHeaders(headers, ORIGIN_A);
    expect(result.has(name)).toBe(false);
  });

  test("content-type はそのまま維持する", () => {
    const headers = new Headers({ "content-type": "text/html; charset=utf-8" });
    const result = sanitizeHeaders(headers, ORIGIN_A);
    expect(result.get("content-type")).toBe("text/html; charset=utf-8");
  });

  test("cache-control はそのまま維持する", () => {
    const headers = new Headers({ "cache-control": "max-age=3600" });
    const result = sanitizeHeaders(headers, ORIGIN_A);
    expect(result.get("cache-control")).toBe("max-age=3600");
  });

  test("Set-Cookie をターゲット origin でスコープ化する", () => {
    const headers = new Headers();
    headers.append("set-cookie", "session=abc; Path=/; Domain=example.com");
    const result = sanitizeHeaders(headers, ORIGIN_A);
    expect(result.get("set-cookie")).toBe(
      `${scoped(ORIGIN_A, "session", "abc")}; Path=/`
    );
  });
});

describe("sanitizeSetCookie", () => {
  test("Domain 除去に加え Cookie 名をスコープ化する", () => {
    const value = "session=abc; Path=/; Domain=example.com; HttpOnly";
    expect(sanitizeSetCookie(value, ORIGIN_A)).toBe(
      `${scoped(ORIGIN_A, "session", "abc")}; Path=/; HttpOnly`
    );
  });

  test("Domain が無くてもスコープ化する", () => {
    const value = "session=abc; Path=/; HttpOnly";
    expect(sanitizeSetCookie(value, ORIGIN_A)).toBe(
      `${scoped(ORIGIN_A, "session", "abc")}; Path=/; HttpOnly`
    );
  });

  test("Secure / SameSite / Path は維持する", () => {
    const value =
      "token=xyz; Path=/; Domain=example.com; Secure; SameSite=Strict";
    expect(sanitizeSetCookie(value, ORIGIN_A)).toBe(
      `${scoped(ORIGIN_A, "token", "xyz")}; Path=/; Secure; SameSite=Strict`
    );
  });

  test("origin が異なれば異なるスコープ名になる", () => {
    const value = "session=abc; Path=/";
    expect(sanitizeSetCookie(value, ORIGIN_A)).not.toBe(
      sanitizeSetCookie(value, ORIGIN_B)
    );
  });

  test("値に = を含んでも値はそのまま維持する", () => {
    const value = "t=YWJj==; Path=/";
    expect(sanitizeSetCookie(value, ORIGIN_A)).toBe(
      `${scoped(ORIGIN_A, "t", "YWJj==")}; Path=/`
    );
  });
});

describe("scopedCookieHeader", () => {
  test("現ターゲット origin にスコープされた Cookie だけを接頭辞無しで返す", () => {
    const header = [
      scoped(ORIGIN_A, "sid", "aaa"),
      scoped(ORIGIN_B, "sid", "bbb"),
    ].join("; ");
    expect(scopedCookieHeader(header, ORIGIN_B)).toBe("sid=bbb");
    expect(scopedCookieHeader(header, ORIGIN_A)).toBe("sid=aaa");
  });

  test("別 origin にスコープされた Cookie は含めない", () => {
    const header = scoped(ORIGIN_B, "sid", "bbb");
    expect(scopedCookieHeader(header, ORIGIN_A)).toBe("");
  });

  test("非スコープ Cookie（インフラ認証・レガシー）は除外する", () => {
    const header = `CF_Authorization=jwt; theme=dark; ${scoped(ORIGIN_A, "sid", "aaa")}`;
    expect(scopedCookieHeader(header, ORIGIN_A)).toBe("sid=aaa");
  });

  test("一致する Cookie が無ければ空文字を返す", () => {
    expect(
      scopedCookieHeader("CF_Authorization=jwt; theme=dark", ORIGIN_A)
    ).toBe("");
  });

  test("元の名前に . を含んでも正しく復元する", () => {
    const header = scoped(ORIGIN_A, "app.sid", "aaa");
    expect(scopedCookieHeader(header, ORIGIN_A)).toBe("app.sid=aaa");
  });
});

describe("forwardableRequestHeaders", () => {
  test("Cookie は現ターゲット origin 分だけを抽出し Authorization は転送する", () => {
    const headers = new Headers({
      cookie: [
        scoped(ORIGIN_A, "sid", "aaa"),
        scoped(ORIGIN_B, "sid", "bbb"),
      ].join("; "),
      authorization: "Bearer xyz",
    });
    expect(forwardableRequestHeaders(headers, ORIGIN_B)).toEqual({
      cookie: "sid=bbb",
      authorization: "Bearer xyz",
    });
  });

  test("あるターゲットの Cookie が別ターゲットの転送に乗らない", () => {
    const headers = new Headers({ cookie: scoped(ORIGIN_A, "sid", "aaa") });
    expect(forwardableRequestHeaders(headers, ORIGIN_B)).toEqual({});
  });

  test("存在しない認証ヘッダーは含めない（無ければ空オブジェクト）", () => {
    const headers = new Headers({ "user-agent": "test" });
    expect(forwardableRequestHeaders(headers, ORIGIN_A)).toEqual({});
  });

  test("許可リスト外のヘッダーは転送しない", () => {
    const headers = new Headers({
      cookie: scoped(ORIGIN_A, "sid", "aaa"),
      "x-secret": "leak",
      "user-agent": "test",
    });
    expect(forwardableRequestHeaders(headers, ORIGIN_A)).toEqual({
      cookie: "sid=aaa",
    });
  });

  test("非スコープのインフラ認証 cookie は転送しない", () => {
    const headers = new Headers({
      cookie: `CF_Authorization=jwt; ${scoped(ORIGIN_A, "sid", "aaa")}`,
      authorization: "Bearer xyz",
    });
    expect(forwardableRequestHeaders(headers, ORIGIN_A)).toEqual({
      cookie: "sid=aaa",
      authorization: "Bearer xyz",
    });
  });

  test("スコープ一致 Cookie が残らなければ Cookie ヘッダーを付けない", () => {
    const headers = new Headers({ cookie: "CF_Authorization=jwt" });
    expect(forwardableRequestHeaders(headers, ORIGIN_A)).toEqual({});
  });
});

describe("relayRequestHeaders", () => {
  test("Cookie は現ターゲット origin 分だけに限定し他は広めに転送する", () => {
    const headers = new Headers({
      "content-type": "application/json",
      authorization: "Bearer xyz",
      cookie: [
        scoped(ORIGIN_A, "sid", "aaa"),
        scoped(ORIGIN_B, "sid", "bbb"),
      ].join("; "),
      "x-csrf-token": "tok",
    });
    expect(relayRequestHeaders(headers, ORIGIN_B)).toEqual({
      "content-type": "application/json",
      authorization: "Bearer xyz",
      cookie: "sid=bbb",
      "x-csrf-token": "tok",
    });
  });

  test("あるターゲットの Cookie が別ターゲットの非 GET 転送に乗らない", () => {
    const headers = new Headers({
      cookie: scoped(ORIGIN_A, "sid", "aaa"),
      "content-type": "application/json",
    });
    const result = relayRequestHeaders(headers, ORIGIN_B);
    expect(result.cookie).toBeUndefined();
    expect(result["content-type"]).toBe("application/json");
  });

  test.each([
    ["host", "example.com"],
    ["connection", "keep-alive"],
    ["content-length", "10"],
    ["transfer-encoding", "chunked"],
    ["accept-encoding", "gzip"],
  ])("hop-by-hop・インフラ系の %s は転送しない", (name, value) => {
    const headers = new Headers({ [name]: value, "x-keep": "1" });
    const result = relayRequestHeaders(headers, ORIGIN_A);
    expect(result[name]).toBeUndefined();
    expect(result["x-keep"]).toBe("1");
  });

  test("プロキシ文脈を漏らす origin / referer は転送しない（#27）", () => {
    const headers = new Headers({
      origin: "https://proxy.example",
      referer: "https://proxy.example/browse?url=https%3A%2F%2Fa.example",
      "content-type": "application/json",
    });
    const result = relayRequestHeaders(headers, ORIGIN_A);
    expect(result.origin).toBeUndefined();
    expect(result.referer).toBeUndefined();
    expect(result["content-type"]).toBe("application/json");
  });

  test("Authorization はクライアント設定値をそのまま転送する（#27）", () => {
    const headers = new Headers({ authorization: "Bearer xyz" });
    expect(relayRequestHeaders(headers, ORIGIN_A).authorization).toBe(
      "Bearer xyz"
    );
  });

  test("非スコープのインフラ認証 cookie は転送しない", () => {
    const headers = new Headers({
      cookie: `CF_Authorization=jwt; ${scoped(ORIGIN_A, "sid", "aaa")}`,
      "content-type": "application/json",
    });
    const result = relayRequestHeaders(headers, ORIGIN_A);
    expect(result.cookie).toBe("sid=aaa");
    expect(result["content-type"]).toBe("application/json");
  });

  test("スコープ一致 Cookie が残らなければ Cookie ヘッダーを付けない", () => {
    const headers = new Headers({
      cookie: "CF_Authorization=jwt",
      "content-type": "application/json",
    });
    const result = relayRequestHeaders(headers, ORIGIN_A);
    expect(result.cookie).toBeUndefined();
    expect(result["content-type"]).toBe("application/json");
  });
});

describe("allowedCorsOrigin", () => {
  test("Origin が Host と同一オリジンなら origin を返す", () => {
    expect(allowedCorsOrigin("https://proxy.example", "proxy.example")).toBe(
      "https://proxy.example"
    );
  });

  test("ポート付きでも host が一致すれば許可する", () => {
    expect(allowedCorsOrigin("http://localhost:3000", "localhost:3000")).toBe(
      "http://localhost:3000"
    );
  });

  test("第三者クロスオリジン（host 不一致）は null", () => {
    expect(
      allowedCorsOrigin("https://evil.example", "proxy.example")
    ).toBeNull();
  });

  test("Origin / Host のいずれかが欠落していれば null", () => {
    expect(allowedCorsOrigin(null, "proxy.example")).toBeNull();
    expect(allowedCorsOrigin("https://proxy.example", null)).toBeNull();
  });

  test("不正な Origin 値は null", () => {
    expect(allowedCorsOrigin("not-a-url", "proxy.example")).toBeNull();
  });
});

describe("buildCorsPreflightHeaders", () => {
  test("許可 Origin をエコーし Allow-Credentials と Request-Headers を反映する", () => {
    const h = buildCorsPreflightHeaders("https://app.example", "x-csrf-token");
    expect(h.get("Access-Control-Allow-Origin")).toBe("https://app.example");
    expect(h.get("Access-Control-Allow-Credentials")).toBe("true");
    expect(h.get("Access-Control-Allow-Headers")).toBe("x-csrf-token");
    expect(h.get("Access-Control-Allow-Methods")).toContain("POST");
    expect(h.get("Vary")).toBe("Origin");
  });

  test("origin が null なら Allow-Origin / Credentials を付けない（* も使わない。#27）", () => {
    const h = buildCorsPreflightHeaders(null, null);
    expect(h.get("Access-Control-Allow-Origin")).toBeNull();
    expect(h.get("Access-Control-Allow-Credentials")).toBeNull();
    expect(h.get("Access-Control-Allow-Headers")).toBe("*");
    expect(h.get("Access-Control-Allow-Methods")).toContain("POST");
  });
});
