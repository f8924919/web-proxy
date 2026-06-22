/** @jest-environment node */
// 仕様: docs/spec/features/proxy.md §ページ遷移のパス反映（#115）
// 対応 Issue: #115

import { buildBrowsePath, targetFromBrowsePath } from "@/lib/proxy/browsePath";

describe("buildBrowsePath", () => {
  test.each([
    [
      "https://duckduckgo.com/?ia=web&q=test",
      "",
      "/browse/https/duckduckgo.com/?ia=web&q=test",
    ],
    ["http://example.com/a/b", "", "/browse/http/example.com/a/b"],
    // パス無しは "/" に正規化
    ["https://example.com", "", "/browse/https/example.com/"],
    ["https://example.com/", "", "/browse/https/example.com/"],
    // ポート込み host
    ["https://host:8080/x", "", "/browse/https/host:8080/x"],
    // BASE_PATH 前置
    [
      "https://duckduckgo.com/?q=test",
      "/proxy/3000",
      "/proxy/3000/browse/https/duckduckgo.com/?q=test",
    ],
  ])("%s (basePath=%s) → %s", (abs, bp, expected) => {
    expect(buildBrowsePath(abs, bp)).toBe(expected);
  });
});

describe("targetFromBrowsePath", () => {
  test.each([
    [
      "/browse/https/duckduckgo.com/",
      "?ia=web&q=test",
      "https://duckduckgo.com/?ia=web&q=test",
    ],
    ["/browse/http/example.com/a/b", "", "http://example.com/a/b"],
    ["/browse/https/host:8080/x", "", "https://host:8080/x"],
    // basePath が残存していても indexOf でマーカーを検出して復元する
    [
      "/proxy/3000/browse/https/duckduckgo.com/",
      "?q=test",
      "https://duckduckgo.com/?q=test",
    ],
  ])("%s + %s → %s", (pathname, search, expected) => {
    expect(targetFromBrowsePath(pathname, search)).toBe(expected);
  });

  test.each([
    ["/browse/", "マーカーのみ"],
    ["/browse/https", "host 欠落"],
    ["/browse/ftp/example.com/x", "非対応スキーム"],
    ["/other/path", "マーカー無し"],
  ])("不正 %s（%s）→ null", (pathname) => {
    expect(targetFromBrowsePath(pathname, "")).toBeNull();
  });

  test("round-trip: buildBrowsePath ↔ targetFromBrowsePath", () => {
    const abs = "https://duckduckgo.com/?ia=web&q=playwright+test";
    const path = buildBrowsePath(abs, "");
    const q = path.indexOf("?");
    const pathname = q === -1 ? path : path.slice(0, q);
    const search = q === -1 ? "" : path.slice(q);
    expect(targetFromBrowsePath(pathname, search)).toBe(abs);
  });
});

// %2F・非 ASCII を含む特殊パスの percent-encoding 保持（#111 と同方針）。
describe("特殊パスの percent-encoding 保持", () => {
  test.each([
    ["https://example.com/a%2Fb/c", "/browse/https/example.com/a%2Fb/c"],
    [
      "https://example.com/%E6%97%A5%E6%9C%AC",
      "/browse/https/example.com/%E6%97%A5%E6%9C%AC",
    ],
  ])("buildBrowsePath %s → %s", (abs, expected) => {
    expect(buildBrowsePath(abs, "")).toBe(expected);
  });

  test.each([
    "https://example.com/a%2Fb/c",
    "https://example.com/%E6%97%A5%E6%9C%AC?q=a%2Fb",
  ])("round-trip で percent-encoding を保つ: %s", (abs) => {
    const path = buildBrowsePath(abs, "");
    const q = path.indexOf("?");
    const pathname = q === -1 ? path : path.slice(0, q);
    const search = q === -1 ? "" : path.slice(q);
    expect(targetFromBrowsePath(pathname, search)).toBe(abs);
  });
});
