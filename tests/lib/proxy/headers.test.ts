/** @jest-environment node */
// 仕様: docs/spec/features/proxy.md §レスポンスヘッダー処理 / §認証情報の転送 / §サイト間 Cookie アイソレーション / §CORS プリフライト対応

import {
  sanitizeHeaders,
  forwardableRequestHeaders,
  relayRequestHeaders,
  buildCorsPreflightHeaders,
  allowedCorsOrigin,
  htmlUiHeaders,
} from "@/lib/proxy/headers";

const ORIGIN_A = "https://a.example";
const ORIGIN_B = "https://b.example";

// テスト用: 中継元ページのオリジン origin を反映したプロキシ origin 上の Referer を
// 組み立てる（#136 の Authorization オリジンスコープ判定の入力）。
// scheme:"browse"（パス反映ナビ）/ "api/proxy"（パス反映アセット）を切り替える。
const proxyRef = (
  origin: string,
  { path = "/", scheme = "browse" as "browse" | "api/proxy" } = {}
): string => {
  const u = new URL(origin);
  return `https://proxy.example/${scheme}/${u.protocol.replace(/:$/, "")}/${u.host}${path}`;
};

describe("sanitizeHeaders", () => {
  const BLOCKED = [
    "content-security-policy",
    "x-frame-options",
    "content-encoding",
    "transfer-encoding",
    "content-length",
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

  // #97: 上流が identity 要求を無視して gzip 応答すると、fetch は本文を展開して渡す一方
  // content-length は圧縮時サイズのまま残る。content-encoding を除去しつつこの値を転送すると
  // 実本文長と宣言長が食い違い ERR_CONTENT_LENGTH_MISMATCH／本文切り詰めを招くため除去する。
  test("content-encoding と共に content-length も除去する（#97）", () => {
    const headers = new Headers({
      "content-encoding": "gzip",
      "content-length": "114",
      "content-type": "text/javascript",
    });
    const result = sanitizeHeaders(headers);
    expect(result.has("content-encoding")).toBe(false);
    expect(result.has("content-length")).toBe(false);
    expect(result.get("content-type")).toBe("text/javascript");
  });

  test("content-type はそのまま維持する", () => {
    const headers = new Headers({ "content-type": "text/html; charset=utf-8" });
    const result = sanitizeHeaders(headers);
    expect(result.get("content-type")).toBe("text/html; charset=utf-8");
  });

  // #131: 中継レスポンスには UI 用のクリックジャッキング防止ヘッダーを付けない
  // （iframe 埋め込み中継を壊さないため）。X-Frame-Options はむしろ除去される。
  test("中継レスポンスに X-Frame-Options を付与しない（#131）", () => {
    const headers = new Headers({ "content-type": "text/html; charset=utf-8" });
    const result = sanitizeHeaders(headers);
    expect(result.has("x-frame-options")).toBe(false);
  });

  test("cache-control はそのまま維持する", () => {
    const headers = new Headers({ "cache-control": "max-age=3600" });
    const result = sanitizeHeaders(headers);
    expect(result.get("cache-control")).toBe("max-age=3600");
  });

  // #151 Phase 1: 中継 Cookie はブラウザへ返さず（document.cookie 露出の遮断）、
  // 保持は cookieJar が担うため Set-Cookie は除去する。
  test("Set-Cookie をブラウザへ返さない（除去する。#151 Phase 1）", () => {
    const headers = new Headers();
    headers.append("set-cookie", "session=abc; Path=/; Domain=example.com");
    const result = sanitizeHeaders(headers);
    expect(result.has("set-cookie")).toBe(false);
  });
});

describe("htmlUiHeaders（#131）", () => {
  test("クリックジャッキング防止に X-Frame-Options: DENY を付与する", () => {
    expect(htmlUiHeaders()["X-Frame-Options"]).toBe("DENY");
  });

  test("HTML の Content-Type を含む", () => {
    expect(htmlUiHeaders()["Content-Type"]).toBe("text/html; charset=utf-8");
  });
});

describe("forwardableRequestHeaders", () => {
  // #151 Phase 1: 往路 Cookie はブラウザ受信分を使わず、呼び出し側が jar から
  // 復元した値（第 3 引数 jarCookie）だけを載せる。
  test("jar 由来の Cookie を載せ、Authorization は中継元一致時に転送する", () => {
    const headers = new Headers({
      authorization: "Bearer xyz",
      referer: proxyRef(ORIGIN_B),
    });
    expect(forwardableRequestHeaders(headers, ORIGIN_B, "sid=bbb")).toEqual({
      cookie: "sid=bbb",
      authorization: "Bearer xyz",
    });
  });

  test("ブラウザ受信の Cookie ヘッダーは上流へ転送しない（jar 由来のみ）", () => {
    const headers = new Headers({ cookie: "__pxy_sid=s1; __pxy_auth=tok" });
    expect(forwardableRequestHeaders(headers, ORIGIN_A, "")).toEqual({});
  });

  test("jar が空なら Cookie ヘッダーを付けない", () => {
    const headers = new Headers({ "user-agent": "test" });
    expect(forwardableRequestHeaders(headers, ORIGIN_A, "")).toEqual({});
  });

  test("許可リスト外のヘッダーは転送しない", () => {
    const headers = new Headers({
      "x-secret": "leak",
      "user-agent": "test",
    });
    expect(forwardableRequestHeaders(headers, ORIGIN_A, "sid=aaa")).toEqual({
      cookie: "sid=aaa",
    });
  });
});

describe("relayRequestHeaders", () => {
  test("jar 由来の Cookie に限定し、他のヘッダーは広めに転送する", () => {
    const headers = new Headers({
      "content-type": "application/json",
      authorization: "Bearer xyz",
      referer: proxyRef(ORIGIN_B, { scheme: "api/proxy" }),
      cookie: "__pxy_sid=s1",
      "x-csrf-token": "tok",
    });
    expect(relayRequestHeaders(headers, ORIGIN_B, "sid=bbb")).toEqual({
      "content-type": "application/json",
      authorization: "Bearer xyz",
      cookie: "sid=bbb",
      "x-csrf-token": "tok",
    });
  });

  test("ブラウザ受信の Cookie は転送せず、jar が空なら Cookie を付けない", () => {
    const headers = new Headers({
      cookie: "__pxy_sid=s1; __pxy_auth=tok",
      "content-type": "application/json",
    });
    const result = relayRequestHeaders(headers, ORIGIN_B, "");
    expect(result.cookie).toBeUndefined();
    expect(result["content-type"]).toBe("application/json");
  });

  test.each([
    ["host", "example.com"],
    ["connection", "keep-alive"],
    ["content-length", "10"],
    ["transfer-encoding", "chunked"],
    ["accept-encoding", "gzip"],
    ["cookie", "__pxy_sid=s1"],
  ])(
    "hop-by-hop・インフラ系・ブラウザ Cookie の %s は素通ししない",
    (name, value) => {
      const headers = new Headers({ [name]: value, "x-keep": "1" });
      const result = relayRequestHeaders(headers, ORIGIN_A, "");
      expect(result[name]).toBeUndefined();
      expect(result["x-keep"]).toBe("1");
    }
  );

  test("プロキシ文脈を漏らす origin / referer は転送しない（#27）", () => {
    const headers = new Headers({
      origin: "https://proxy.example",
      referer: "https://proxy.example/browse?url=https%3A%2F%2Fa.example",
      "content-type": "application/json",
    });
    const result = relayRequestHeaders(headers, ORIGIN_A, "");
    expect(result.origin).toBeUndefined();
    expect(result.referer).toBeUndefined();
    expect(result["content-type"]).toBe("application/json");
  });
});

// #136: Authorization のオリジンスコープ。中継元ページ（Referer に反映）の origin が
// 宛先ターゲット origin と完全一致する場合のみ転送し、それ以外は fail-closed で除去する。
describe("Authorization のオリジンスコープ（#136）", () => {
  describe.each([
    ["forwardableRequestHeaders", forwardableRequestHeaders],
    ["relayRequestHeaders", relayRequestHeaders],
  ] as const)("%s", (_name, fn) => {
    test("中継元 origin が宛先と一致すれば転送する（パス反映ナビ Referer）", () => {
      const headers = new Headers({
        authorization: "Bearer xyz",
        referer: proxyRef(ORIGIN_A, { path: "/page?q=1", scheme: "browse" }),
      });
      expect(fn(headers, ORIGIN_A, "").authorization).toBe("Bearer xyz");
    });

    test("中継元 origin が宛先と一致すれば転送する（パス反映アセット Referer）", () => {
      const headers = new Headers({
        authorization: "Bearer xyz",
        referer: proxyRef(ORIGIN_A, { scheme: "api/proxy" }),
      });
      expect(fn(headers, ORIGIN_A, "").authorization).toBe("Bearer xyz");
    });

    test("中継元 origin が宛先と一致すれば転送する（後方互換 ?url= Referer）", () => {
      const headers = new Headers({
        authorization: "Bearer xyz",
        referer: `https://proxy.example/browse?url=${encodeURIComponent(
          `${ORIGIN_A}/page`
        )}`,
      });
      expect(fn(headers, ORIGIN_A, "").authorization).toBe("Bearer xyz");
    });

    test("中継元 origin が宛先と異なれば転送しない", () => {
      const headers = new Headers({
        authorization: "Bearer xyz",
        referer: proxyRef(ORIGIN_A),
      });
      expect(fn(headers, ORIGIN_B, "").authorization).toBeUndefined();
    });

    test("サブドメイン違いは不一致として転送しない", () => {
      const headers = new Headers({
        authorization: "Bearer xyz",
        referer: proxyRef("https://sub.a.example"),
      });
      expect(fn(headers, ORIGIN_A, "").authorization).toBeUndefined();
    });

    test("Referer 欠落は fail-closed で転送しない", () => {
      const headers = new Headers({ authorization: "Bearer xyz" });
      expect(fn(headers, ORIGIN_A, "").authorization).toBeUndefined();
    });

    test("中継元ターゲットを復元できない Referer は転送しない", () => {
      const headers = new Headers({
        authorization: "Bearer xyz",
        referer: "https://proxy.example/about",
      });
      expect(fn(headers, ORIGIN_A, "").authorization).toBeUndefined();
    });

    test("パース不能な Referer は転送しない", () => {
      const headers = new Headers({
        authorization: "Bearer xyz",
        referer: "::not a url::",
      });
      expect(fn(headers, ORIGIN_A, "").authorization).toBeUndefined();
    });
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
