/** @jest-environment node */
// 仕様: docs/spec/features/proxy.md §クライアント IP の特定

import { getClientIp } from "@/lib/proxy/clientIp";

describe("getClientIp", () => {
  test("cf-connecting-ip を最優先で使う", () => {
    const headers = new Headers({
      "cf-connecting-ip": "203.0.113.9",
      "x-forwarded-for": "198.51.100.1, 10.0.0.1",
      "x-real-ip": "192.0.2.5",
    });
    expect(getClientIp(headers)).toBe("203.0.113.9");
  });

  test("cf-connecting-ip が無ければ x-forwarded-for の先頭を使う", () => {
    const headers = new Headers({
      "x-forwarded-for": "198.51.100.1, 10.0.0.1",
      "x-real-ip": "192.0.2.5",
    });
    expect(getClientIp(headers)).toBe("198.51.100.1");
  });

  test("cf-connecting-ip / x-forwarded-for が無ければ x-real-ip を使う", () => {
    const headers = new Headers({ "x-real-ip": "192.0.2.5" });
    expect(getClientIp(headers)).toBe("192.0.2.5");
  });

  test("いずれのヘッダーも無ければ 'unknown' を返す", () => {
    expect(getClientIp(new Headers())).toBe("unknown");
  });
});
