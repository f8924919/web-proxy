/** @jest-environment node */
// 仕様: docs/spec/features/proxy.md §Service Worker による実行時リクエスト横取り
//      docs/arch/proxy.md §Service Worker

// public/sw.js は配信される SW 本体。純粋ロジックは module.exports で公開され、
// SW ランタイム配線は importScripts の有無でガードされるため Node 環境で読み込める。
// eslint-disable-next-line @typescript-eslint/no-require-imports
const sw = require("../../../public/sw.js");
const { deriveBasePath, isProxyOwnPath, extractTarget, rewriteRequestUrl } = sw;

const SW_ORIGIN = "https://host";
const PAGE = (target: string, basePath = "") =>
  `${SW_ORIGIN}${basePath}/browse?url=${encodeURIComponent(target)}`;
const PROXY = (absolute: string, basePath = "") =>
  `${basePath}/api/proxy?url=${encodeURIComponent(absolute)}`;

describe("deriveBasePath", () => {
  test.each([
    ["https://host/proxy/3000/", "/proxy/3000"],
    ["https://host/", ""],
  ])("scope %s → basePath %s", (scope, expected) => {
    expect(deriveBasePath(scope)).toBe(expected);
  });
});

describe("isProxyOwnPath", () => {
  test.each([
    ["/", true],
    ["/browse", true],
    ["/api/proxy", true],
    ["/_next/static/x.js", true],
    ["/sw.js", true],
    ["/images/nav_logo229.png", false],
    ["/xjs/_/js/k=foo", false],
    ["/browser/app.js", false],
    ["/api/proxyData", false],
  ])("basePath='' %s → %s", (pathname, expected) => {
    expect(isProxyOwnPath(pathname, "")).toBe(expected);
  });

  test.each([
    ["/proxy/3000/browse", true],
    ["/proxy/3000/api/proxy", true],
    ["/proxy/3000/", true],
    ["/images/x.png", false],
  ])("basePath='/proxy/3000' %s → %s", (pathname, expected) => {
    expect(isProxyOwnPath(pathname, "/proxy/3000")).toBe(expected);
  });
});

describe("extractTarget", () => {
  test("url パラメータを取り出す", () => {
    expect(extractTarget(PAGE("https://www.google.com"))).toBe(
      "https://www.google.com"
    );
  });

  test("BASE_PATH 付きページからも取り出す", () => {
    expect(extractTarget(PAGE("https://www.google.com", "/proxy/3000"))).toBe(
      "https://www.google.com"
    );
  });

  test("url が無ければ null", () => {
    expect(extractTarget(`${SW_ORIGIN}/browse`)).toBeNull();
  });
});

describe("rewriteRequestUrl", () => {
  const page = PAGE("https://www.google.com");

  test("クロスオリジンの絶対 URL → /api/proxy", () => {
    expect(
      rewriteRequestUrl("https://ssl.gstatic.com/foo.js", page, SW_ORIGIN, "")
    ).toBe(PROXY("https://ssl.gstatic.com/foo.js"));
  });

  test("同一オリジンのルート絶対パス → ターゲット origin に解決して /api/proxy", () => {
    expect(
      rewriteRequestUrl(
        `${SW_ORIGIN}/images/nav_logo229.png`,
        page,
        SW_ORIGIN,
        ""
      )
    ).toBe(PROXY("https://www.google.com/images/nav_logo229.png"));
  });

  test.each([
    [`${SW_ORIGIN}/api/proxy?url=x`, "api/proxy 自身"],
    [`${SW_ORIGIN}/browse?url=x`, "browse 自身"],
    [`${SW_ORIGIN}/_next/static/x.js`, "_next アセット"],
    [`${SW_ORIGIN}/`, "ホーム"],
  ])("自前ルート %s（%s）→ null（素通し）", (reqUrl) => {
    expect(rewriteRequestUrl(reqUrl, page, SW_ORIGIN, "")).toBeNull();
  });

  test("ページに url が無ければ同一オリジン非自前パスは null", () => {
    expect(
      rewriteRequestUrl(
        `${SW_ORIGIN}/images/x.png`,
        `${SW_ORIGIN}/browse`,
        SW_ORIGIN,
        ""
      )
    ).toBeNull();
  });

  describe("BASE_PATH=/proxy/3000", () => {
    const bp = "/proxy/3000";
    const pageBp = PAGE("https://www.google.com", bp);

    test("クロスオリジン → /proxy/3000/api/proxy", () => {
      expect(
        rewriteRequestUrl(
          "https://ssl.gstatic.com/foo.js",
          pageBp,
          SW_ORIGIN,
          bp
        )
      ).toBe(PROXY("https://ssl.gstatic.com/foo.js", bp));
    });

    test("ルート絶対パス → ターゲット解決して /proxy/3000/api/proxy", () => {
      expect(
        rewriteRequestUrl(`${SW_ORIGIN}/images/x.png`, pageBp, SW_ORIGIN, bp)
      ).toBe(PROXY("https://www.google.com/images/x.png", bp));
    });

    test("prefix 付き自前ルート → null", () => {
      expect(
        rewriteRequestUrl(
          `${SW_ORIGIN}/proxy/3000/api/proxy?url=x`,
          pageBp,
          SW_ORIGIN,
          bp
        )
      ).toBeNull();
    });
  });
});
