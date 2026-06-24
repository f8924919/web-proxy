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
// パス反映ナビ形式の閲覧ページ URL（/browse/<scheme>/<host>/<path>・#115）。
const NAVPAGE = (target: string, basePath = "") => {
  const u = new URL(target);
  return `${SW_ORIGIN}${basePath}/browse/${u.protocol.replace(/:$/, "")}/${u.host}${u.pathname}${u.search}${u.hash}`;
};
// パス反映形式（/api/proxy/<scheme>/<host>/<path>）の独立オラクル（#100）。
const PROXY = (absolute: string, basePath = "") => {
  const u = new URL(absolute);
  return `${basePath}/api/proxy/${u.protocol.replace(/:$/, "")}/${u.host}${u.pathname}${u.search}${u.hash}`;
};

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
    // /_next/image はターゲット（Next.js 製）の最適化エンドポイントなので自前ルート扱いしない（#102）
    ["/_next/image", false],
    ["/_next/data/build/x.json", true],
    ["/sw.js", true],
    ["/unlock", true],
    ["/images/nav_logo229.png", false],
    ["/xjs/_/js/k=foo", false],
    ["/browser/app.js", false],
    ["/api/proxyData", false],
    // パス反映形式の相対 import（#100）は /api/proxy/ プレフィックス＝自前ルート（素通し）
    ["/api/proxy/https/example.com/_main/nuxt/x.js", true],
  ])("basePath='' %s → %s", (pathname, expected) => {
    expect(isProxyOwnPath(pathname, "")).toBe(expected);
  });

  test.each([
    ["/proxy/3000/browse", true],
    ["/proxy/3000/api/proxy", true],
    ["/proxy/3000/", true],
    ["/proxy/3000/_next/static/x.js", true],
    ["/proxy/3000/_next/image", false],
    ["/images/x.png", false],
    ["/proxy/3000/api/proxy/https/example.com/_main/nuxt/x.js", true],
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

  test("パス反映ナビ形式の閲覧ページから取り出す（#115）", () => {
    expect(
      extractTarget(NAVPAGE("https://duckduckgo.com/?ia=web&q=test"))
    ).toBe("https://duckduckgo.com/?ia=web&q=test");
  });

  test("BASE_PATH 付きのパス反映ページからも取り出す（#115）", () => {
    expect(
      extractTarget(NAVPAGE("https://www.google.com/", "/proxy/3000"))
    ).toBe("https://www.google.com/");
  });
});

describe("rewriteRequestUrl（パス反映ナビの閲覧ページ・#115）", () => {
  test("同一オリジンのルート絶対パス → パス反映ページの target origin に解決して /api/proxy", () => {
    const page = NAVPAGE("https://duckduckgo.com/?ia=web&q=test");
    expect(
      rewriteRequestUrl(`${SW_ORIGIN}/dist/wpm.js`, page, SW_ORIGIN, "")
    ).toBe(PROXY("https://duckduckgo.com/dist/wpm.js"));
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

  describe("/_next/image の振り向け（#102）", () => {
    const inner = "https://s.yimg.jp/i/kids/x.png";
    const nextImg = (basePath = "") =>
      `${SW_ORIGIN}${basePath}/_next/image?url=${encodeURIComponent(inner)}&w=256&q=75`;
    const resolvedImg =
      "https://kids.yahoo.co.jp/_next/image?url=" +
      `${encodeURIComponent(inner)}&w=256&q=75`;
    const kidsPage = (basePath = "") =>
      PAGE("https://kids.yahoo.co.jp", basePath);

    test("browse ページ上ではターゲット origin の /_next/image へ振り向ける", () => {
      expect(rewriteRequestUrl(nextImg(), kidsPage(), SW_ORIGIN, "")).toBe(
        PROXY(resolvedImg)
      );
    });

    test("BASE_PATH 付きでも振り向ける", () => {
      const bp = "/proxy/3000";
      expect(rewriteRequestUrl(nextImg(bp), kidsPage(bp), SW_ORIGIN, bp)).toBe(
        PROXY(resolvedImg, bp)
      );
    });

    test("ターゲット不明（url 無しページ）では素通し（null）＝プロキシ自身の最適化を壊さない", () => {
      expect(
        rewriteRequestUrl(nextImg(), `${SW_ORIGIN}/`, SW_ORIGIN, "")
      ).toBeNull();
    });

    test("/_next/static は引き続き自前ルートとして素通し（回帰防止）", () => {
      expect(
        rewriteRequestUrl(
          `${SW_ORIGIN}/_next/static/chunks/x.js`,
          kidsPage(),
          SW_ORIGIN,
          ""
        )
      ).toBeNull();
    });
  });

  describe("パス反映形式の相対 import は自前ルート＝素通し（#100）", () => {
    test("同一オリジンの /api/proxy/<scheme>/<host>/... は null（素通し）", () => {
      // チャンク分割 SPA の相対 import はパス反映形式に着地する。/api/proxy/ は
      // 自前ルートのため SW は素通しし、ルートが中継する。
      expect(
        rewriteRequestUrl(
          `${SW_ORIGIN}/api/proxy/https/www.google.com/_main/nuxt/x.js`,
          page,
          SW_ORIGIN,
          ""
        )
      ).toBeNull();
    });

    test("BASE_PATH 付きでも /api/proxy/<scheme>/<host>/... は null", () => {
      const bp = "/proxy/3000";
      expect(
        rewriteRequestUrl(
          `${SW_ORIGIN}${bp}/api/proxy/https/www.google.com/_main/nuxt/x.js`,
          PAGE("https://www.google.com", bp),
          SW_ORIGIN,
          bp
        )
      ).toBeNull();
    });
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
