/** @jest-environment node */
// 仕様: docs/spec/features/proxy.md §プロキシ URL スキーム（パス反映）
// 対応 Issue: #100

import { buildProxyPath, targetFromProxyPath } from "@/lib/proxy/proxyPath";

describe("buildProxyPath", () => {
  test.each([
    [
      "https://premium.yahoo.co.jp/_main/nuxt/x.js",
      "",
      "/api/proxy/https/premium.yahoo.co.jp/_main/nuxt/x.js",
    ],
    ["http://example.com/a/b.css", "", "/api/proxy/http/example.com/a/b.css"],
    // パス無しは "/" に正規化
    ["https://example.com", "", "/api/proxy/https/example.com/"],
    ["https://example.com/", "", "/api/proxy/https/example.com/"],
    // ポート込み host
    ["https://host:8080/x.js", "", "/api/proxy/https/host:8080/x.js"],
    // ターゲットのクエリは中継 URL のクエリへ
    [
      "https://example.com/q?a=1&b=2",
      "",
      "/api/proxy/https/example.com/q?a=1&b=2",
    ],
    // BASE_PATH 前置
    [
      "https://premium.yahoo.co.jp/_main/nuxt/x.js",
      "/proxy/3000",
      "/proxy/3000/api/proxy/https/premium.yahoo.co.jp/_main/nuxt/x.js",
    ],
  ])("%s (basePath=%s) → %s", (abs, bp, expected) => {
    expect(buildProxyPath(abs, bp)).toBe(expected);
  });

  test("/_next/image の内側 ?url= をクエリとして保持する（#102 経路）", () => {
    const inner = "https://s.yimg.jp/i/x.png";
    const abs = `https://kids.yahoo.co.jp/_next/image?url=${encodeURIComponent(inner)}&w=256&q=75`;
    expect(buildProxyPath(abs, "")).toBe(
      `/api/proxy/https/kids.yahoo.co.jp/_next/image?url=${encodeURIComponent(inner)}&w=256&q=75`
    );
  });
});

describe("targetFromProxyPath", () => {
  test.each([
    [
      "/api/proxy/https/premium.yahoo.co.jp/_main/nuxt/x.js",
      "",
      "https://premium.yahoo.co.jp/_main/nuxt/x.js",
    ],
    ["/api/proxy/http/example.com/a/b.css", "", "http://example.com/a/b.css"],
    ["/api/proxy/https/host:8080/x.js", "", "https://host:8080/x.js"],
    ["/api/proxy/https/example.com/", "", "https://example.com/"],
    // basePath が残存していても indexOf でマーカーを検出して復元する
    [
      "/proxy/3000/api/proxy/https/premium.yahoo.co.jp/_main/nuxt/x.js",
      "",
      "https://premium.yahoo.co.jp/_main/nuxt/x.js",
    ],
  ])("%s → %s", (pathname, search, expected) => {
    expect(targetFromProxyPath(pathname, search)).toBe(expected);
  });

  test("ターゲットのクエリを付与する", () => {
    expect(
      targetFromProxyPath("/api/proxy/https/example.com/q", "?a=1&b=2")
    ).toBe("https://example.com/q?a=1&b=2");
  });

  test("/_next/image の内側 ?url= を復元する", () => {
    const inner = "https://s.yimg.jp/i/x.png";
    const search = `?url=${encodeURIComponent(inner)}&w=256&q=75`;
    expect(
      targetFromProxyPath(
        "/api/proxy/https/kids.yahoo.co.jp/_next/image",
        search
      )
    ).toBe(`https://kids.yahoo.co.jp/_next/image${search}`);
  });

  test.each([
    ["/api/proxy/", "マーカーのみ"],
    ["/api/proxy/https", "host 欠落"],
    ["/api/proxy/ftp/example.com/x", "非対応スキーム"],
    ["/other/path", "マーカー無し"],
  ])("不正 %s（%s）→ null", (pathname) => {
    expect(targetFromProxyPath(pathname, "")).toBeNull();
  });

  test("round-trip: buildProxyPath ↔ targetFromProxyPath", () => {
    const abs = "https://premium.yahoo.co.jp/_main/nuxt/Bk-Yld_Qv.js?v=5";
    const path = buildProxyPath(abs, "");
    const qIndex = path.indexOf("?");
    const pathname = qIndex === -1 ? path : path.slice(0, qIndex);
    const search = qIndex === -1 ? "" : path.slice(qIndex);
    expect(targetFromProxyPath(pathname, search)).toBe(abs);
  });
});
