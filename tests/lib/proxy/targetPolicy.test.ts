/** @jest-environment node */
// 仕様: docs/spec/features/proxy.md §中継対象スキーム・ポートの制限（#133）

import {
  isAllowedTarget,
  allowedPortsFromEnv,
  DEFAULT_ALLOWED_PORTS,
} from "@/lib/proxy/targetPolicy";

describe("allowedPortsFromEnv", () => {
  test("未設定なら既定の 80 / 443 のみ", () => {
    const ports = allowedPortsFromEnv({});
    expect([...ports].sort((a, b) => a - b)).toEqual([80, 443]);
  });

  test("PROXY_ALLOWED_PORTS のポートを既定へ追加する", () => {
    const ports = allowedPortsFromEnv({ PROXY_ALLOWED_PORTS: "8080,8443" });
    expect([...ports].sort((a, b) => a - b)).toEqual([80, 443, 8080, 8443]);
  });

  test("既定の 80 / 443 は env で外せず常に含まれる", () => {
    const ports = allowedPortsFromEnv({ PROXY_ALLOWED_PORTS: "8080" });
    expect(ports.has(80)).toBe(true);
    expect(ports.has(443)).toBe(true);
  });

  test("空白・空要素は無視する", () => {
    const ports = allowedPortsFromEnv({
      PROXY_ALLOWED_PORTS: " 8080 , ,8443 ",
    });
    expect([...ports].sort((a, b) => a - b)).toEqual([80, 443, 8080, 8443]);
  });

  test("非整数・範囲外（0 / 65536 / 負）は無視する", () => {
    const ports = allowedPortsFromEnv({
      PROXY_ALLOWED_PORTS: "abc,0,65536,-1,80.5,3000",
    });
    expect([...ports].sort((a, b) => a - b)).toEqual([80, 443, 3000]);
  });

  test("DEFAULT_ALLOWED_PORTS は 80 / 443", () => {
    expect([...DEFAULT_ALLOWED_PORTS].sort((a, b) => a - b)).toEqual([80, 443]);
  });
});

describe("isAllowedTarget", () => {
  const defaults = allowedPortsFromEnv({});

  test("http（ポート明示なし＝80）は許可", () => {
    expect(isAllowedTarget(new URL("http://example.com/"), defaults)).toBe(
      true
    );
  });

  test("https（ポート明示なし＝443）は許可", () => {
    expect(isAllowedTarget(new URL("https://example.com/"), defaults)).toBe(
      true
    );
  });

  test("明示 80 / 443 は許可", () => {
    expect(isAllowedTarget(new URL("http://example.com:80/"), defaults)).toBe(
      true
    );
    expect(isAllowedTarget(new URL("https://example.com:443/"), defaults)).toBe(
      true
    );
  });

  test("非標準ポートは既定で拒否", () => {
    expect(isAllowedTarget(new URL("http://example.com:8080/"), defaults)).toBe(
      false
    );
    expect(
      isAllowedTarget(new URL("https://example.com:8443/"), defaults)
    ).toBe(false);
  });

  test("env で追加許可したポートは許可", () => {
    const ports = allowedPortsFromEnv({ PROXY_ALLOWED_PORTS: "8080" });
    expect(isAllowedTarget(new URL("http://example.com:8080/"), ports)).toBe(
      true
    );
  });

  test("非 http(s) スキームは拒否（ポートが許可集合にあっても）", () => {
    // ftp の既定ポート 21 ではなく、ポートを 80 にしてもスキームで弾く
    expect(isAllowedTarget(new URL("ftp://example.com:80/"), defaults)).toBe(
      false
    );
    expect(isAllowedTarget(new URL("file:///etc/passwd"), defaults)).toBe(
      false
    );
  });
});
