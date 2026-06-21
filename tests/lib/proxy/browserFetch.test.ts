/** @jest-environment node */
// 仕様: docs/spec/features/proxy.md §ブラウザバック中継（browser-backed fetch）

import {
  parseBrowserHosts,
  browserTierConfigFromEnv,
  shouldUseBrowser,
  resolveBrowserWaitConfig,
  cookieToSetCookie,
  browserBackendFromEnv,
} from "@/lib/proxy/browserFetch";

describe("parseBrowserHosts", () => {
  test.each([
    [undefined, []],
    ["", []],
    ["  ", []],
    ["a.com,b.com", ["a.com", "b.com"]],
    [" a.com , b.com ", ["a.com", "b.com"]],
    ["a.com,,b.com,", ["a.com", "b.com"]],
    [".a.com", ["a.com"]],
    ["A.COM", ["a.com"]],
  ])("parses %p into %p", (raw, expected) => {
    expect(parseBrowserHosts(raw)).toEqual(expected);
  });
});

describe("browserTierConfigFromEnv", () => {
  test("returns off with no hosts when env unset", () => {
    expect(browserTierConfigFromEnv({})).toEqual({ mode: "off", hosts: [] });
  });

  test("falls back to allowlist when mode unset but hosts present", () => {
    expect(browserTierConfigFromEnv({ PROXY_BROWSER_HOSTS: "a.com" })).toEqual({
      mode: "allowlist",
      hosts: ["a.com"],
    });
  });

  test("falls back to off for an invalid mode with no hosts", () => {
    expect(browserTierConfigFromEnv({ PROXY_BROWSER_MODE: "bogus" })).toEqual({
      mode: "off",
      hosts: [],
    });
  });

  test.each([
    ["on", "on"],
    ["allowlist", "allowlist"],
    ["off", "off"],
    ["ON", "on"],
  ])("honors explicit mode %p", (raw, expected) => {
    expect(browserTierConfigFromEnv({ PROXY_BROWSER_MODE: raw }).mode).toBe(
      expected
    );
  });
});

describe("shouldUseBrowser", () => {
  test("off never uses the browser", () => {
    expect(
      shouldUseBrowser("https://a.com/", { mode: "off", hosts: ["a.com"] })
    ).toBe(false);
  });

  test("on always uses the browser", () => {
    expect(
      shouldUseBrowser("https://anything.example/", { mode: "on", hosts: [] })
    ).toBe(true);
  });

  test.each([
    ["https://example.com/path", true, "exact host"],
    ["https://www.example.com/", true, "subdomain suffix"],
    ["https://deep.sub.example.com/", true, "deep subdomain"],
    ["https://notexample.com/", false, "non-matching suffix boundary"],
    ["https://example.com.evil.test/", false, "suffix not at boundary"],
    ["not a url", false, "invalid url"],
  ])("allowlist for %p -> %p (%s)", (url, expected) => {
    expect(
      shouldUseBrowser(url, { mode: "allowlist", hosts: ["example.com"] })
    ).toBe(expected);
  });

  test("allowlist with empty hosts never matches", () => {
    expect(
      shouldUseBrowser("https://a.com/", { mode: "allowlist", hosts: [] })
    ).toBe(false);
  });
});

describe("resolveBrowserWaitConfig", () => {
  test("uses defaults when env unset", () => {
    expect(resolveBrowserWaitConfig({})).toEqual({
      waitUntil: "load",
      timeoutMs: 15000,
      settleMs: 1500,
    });
  });

  test("honors valid overrides", () => {
    expect(
      resolveBrowserWaitConfig({
        PROXY_BROWSER_WAIT_UNTIL: "networkidle",
        PROXY_BROWSER_TIMEOUT_MS: "30000",
        PROXY_BROWSER_SETTLE_MS: "0",
      })
    ).toEqual({ waitUntil: "networkidle", timeoutMs: 30000, settleMs: 0 });
  });

  test.each([
    ["bogus", "load"],
    ["", "load"],
  ])("falls back waitUntil for %p", (raw, expected) => {
    expect(
      resolveBrowserWaitConfig({ PROXY_BROWSER_WAIT_UNTIL: raw }).waitUntil
    ).toBe(expected);
  });

  test.each([["abc"], ["-5"], [""]])(
    "falls back timeout for invalid %p",
    (raw) => {
      expect(
        resolveBrowserWaitConfig({ PROXY_BROWSER_TIMEOUT_MS: raw }).timeoutMs
      ).toBe(15000);
    }
  );
});

describe("cookieToSetCookie", () => {
  test("emits name=value with default Path and no Domain", () => {
    const out = cookieToSetCookie({ name: "sid", value: "abc" });
    expect(out).toBe("sid=abc; Path=/");
    expect(out.toLowerCase()).not.toContain("domain=");
  });

  test("reflects Secure / HttpOnly / SameSite and explicit Path", () => {
    const out = cookieToSetCookie({
      name: "sid",
      value: "abc",
      path: "/app",
      secure: true,
      httpOnly: true,
      sameSite: "Lax",
    });
    expect(out).toBe("sid=abc; Path=/app; Secure; HttpOnly; SameSite=Lax");
  });

  test("includes Expires for a persistent cookie", () => {
    const expires = 1700000000;
    const out = cookieToSetCookie({ name: "sid", value: "abc", expires });
    expect(out).toContain(`Expires=${new Date(expires * 1000).toUTCString()}`);
  });

  test("omits Expires for a session cookie (expires = -1)", () => {
    const out = cookieToSetCookie({ name: "sid", value: "abc", expires: -1 });
    expect(out.toLowerCase()).not.toContain("expires=");
  });
});

describe("browserBackendFromEnv", () => {
  // 仕様: docs/spec/features/proxy.md §ブラウザ実行基盤（バックエンドの差し替え・#71）
  test("PROXY_BROWSER_CDP_URL 未設定なら自前 Chromium 起動（launch）", () => {
    expect(browserBackendFromEnv({})).toEqual({ mode: "launch" });
  });

  test.each(["", "   "])(
    "空・空白のみの CDP URL は launch にフォールバック（%p）",
    (raw) => {
      expect(browserBackendFromEnv({ PROXY_BROWSER_CDP_URL: raw })).toEqual({
        mode: "launch",
      });
    }
  );

  test("CDP URL があれば cdp バックエンド（endpoint を保持）", () => {
    const endpoint = "wss://chrome.example.com/?token=secret";
    expect(browserBackendFromEnv({ PROXY_BROWSER_CDP_URL: endpoint })).toEqual({
      mode: "cdp",
      endpoint,
    });
  });

  test("CDP URL の前後空白はトリムする", () => {
    expect(
      browserBackendFromEnv({ PROXY_BROWSER_CDP_URL: "  wss://h/cdp  " })
    ).toEqual({ mode: "cdp", endpoint: "wss://h/cdp" });
  });
});
