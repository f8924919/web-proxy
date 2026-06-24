/** @jest-environment node */
// 仕様: docs/spec/features/proxy.md §ブラウザバック中継（browser-backed fetch）

import {
  parseBrowserHosts,
  browserTierConfigFromEnv,
  shouldUseBrowser,
  resolveBrowserWaitConfig,
  cookieToSetCookie,
  browserBackendFromEnv,
  browserProxyFromEnv,
  STEALTH_LAUNCH_ARGS,
  STEALTH_INIT_SCRIPT,
  inlineCssomStyles,
  measureDomByteLength,
  domSizeExceedsLimit,
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

describe("browserProxyFromEnv", () => {
  // 仕様: docs/spec/features/proxy.md §アンチボット対策（egress IP / stealth・#73）
  test.each(["", "   "])(
    "PROXY_BROWSER_PROXY_SERVER 未設定・空白なら undefined（%p）",
    (raw) => {
      expect(
        browserProxyFromEnv({ PROXY_BROWSER_PROXY_SERVER: raw })
      ).toBeUndefined();
    }
  );

  test("空 env なら undefined", () => {
    expect(browserProxyFromEnv({})).toBeUndefined();
  });

  test("server のみ指定", () => {
    expect(
      browserProxyFromEnv({ PROXY_BROWSER_PROXY_SERVER: "http://h:8080" })
    ).toEqual({ server: "http://h:8080" });
  });

  test("server の前後空白はトリムする", () => {
    expect(
      browserProxyFromEnv({ PROXY_BROWSER_PROXY_SERVER: "  socks5://h:1080  " })
    ).toEqual({ server: "socks5://h:1080" });
  });

  test("username / password を含める", () => {
    expect(
      browserProxyFromEnv({
        PROXY_BROWSER_PROXY_SERVER: "http://h:8080",
        PROXY_BROWSER_PROXY_USERNAME: "user",
        PROXY_BROWSER_PROXY_PASSWORD: "pass",
      })
    ).toEqual({ server: "http://h:8080", username: "user", password: "pass" });
  });

  test("空の username / password は含めない", () => {
    expect(
      browserProxyFromEnv({
        PROXY_BROWSER_PROXY_SERVER: "http://h:8080",
        PROXY_BROWSER_PROXY_USERNAME: "",
        PROXY_BROWSER_PROXY_PASSWORD: "",
      })
    ).toEqual({ server: "http://h:8080" });
  });
});

describe("stealth 定数（#73）", () => {
  test("launch args は AutomationControlled を無効化する", () => {
    expect(STEALTH_LAUNCH_ARGS).toContain(
      "--disable-blink-features=AutomationControlled"
    );
  });

  test("init script は navigator.webdriver を隠す", () => {
    expect(STEALTH_INIT_SCRIPT).toMatch(/webdriver/);
  });
});

// inlineCssomStyles（#120）。page.content() が CSSOM 注入 CSS / adoptedStyleSheets を
// シリアライズしない問題を補うため、取得直前に DOM へ実体化する DOM 操作関数。
// 実ブラウザ（page.evaluate）配線はテスト対象外（テスト方針）のため、document 互換の
// フェイクオブジェクトで分岐を検証する。
describe("inlineCssomStyles（#120）", () => {
  const rule = (cssText: string) => ({ cssText });

  type FakeStyle = {
    textContent: string;
    sheet: { readonly cssRules: { cssText: string }[] } | null;
  };

  function fakeStyle(opts: {
    text?: string;
    rules?: { cssText: string }[];
    throwOnRules?: boolean;
    noSheet?: boolean;
  }): FakeStyle {
    const {
      text = "",
      rules = [],
      throwOnRules = false,
      noSheet = false,
    } = opts;
    return {
      textContent: text,
      sheet: noSheet
        ? null
        : {
            get cssRules() {
              if (throwOnRules) throw new Error("SecurityError: cross-origin");
              return rules;
            },
          },
    };
  }

  function fakeDoc(opts: {
    styles?: FakeStyle[];
    adopted?: { readonly cssRules: { cssText: string }[] }[];
  }) {
    const { styles = [], adopted = [] } = opts;
    const appended: {
      attrs: Record<string, string>;
      textContent: string;
    }[] = [];
    return {
      doc: {
        querySelectorAll: (sel: string) => (sel === "style" ? styles : []),
        adoptedStyleSheets: adopted,
        createElement: () => ({
          attrs: {} as Record<string, string>,
          textContent: "",
          setAttribute(k: string, v: string) {
            this.attrs[k] = v;
          },
        }),
        head: {
          appendChild: (node: {
            attrs: Record<string, string>;
            textContent: string;
          }) => appended.push(node),
        },
      },
      appended,
    };
  }

  test("空 <style> を CSSOM ルールで実体化する", () => {
    const style = fakeStyle({
      text: "",
      rules: [rule(".a{color:red}"), rule(".b{color:blue}")],
    });
    const { doc } = fakeDoc({ styles: [style] });
    inlineCssomStyles(doc as never);
    expect(style.textContent).toBe(".a{color:red}.b{color:blue}");
  });

  test("既存テキストが CSSOM ルールより長い <style> は書き換えない（冪等）", () => {
    const existing = "X".repeat(100);
    const style = fakeStyle({ text: existing, rules: [rule(".a{}")] });
    const { doc } = fakeDoc({ styles: [style] });
    inlineCssomStyles(doc as never);
    expect(style.textContent).toBe(existing);
  });

  test("cssRules 読取りで例外を投げる <style> はスキップし、他は処理する（全損しない）", () => {
    const bad = fakeStyle({ text: "", throwOnRules: true });
    const good = fakeStyle({ text: "", rules: [rule(".g{}")] });
    const { doc } = fakeDoc({ styles: [bad, good] });
    expect(() => inlineCssomStyles(doc as never)).not.toThrow();
    expect(bad.textContent).toBe("");
    expect(good.textContent).toBe(".g{}");
  });

  test("sheet が無い（未パース）<style> はスキップする", () => {
    const style = fakeStyle({ text: "", noSheet: true });
    const { doc } = fakeDoc({ styles: [style] });
    inlineCssomStyles(doc as never);
    expect(style.textContent).toBe("");
  });

  test("adoptedStyleSheets を <style data-proxy-adopted> として head へ出力する", () => {
    const { doc, appended } = fakeDoc({
      adopted: [
        {
          get cssRules() {
            return [rule(":root{--x:1}")];
          },
        },
      ],
    });
    inlineCssomStyles(doc as never);
    expect(appended).toHaveLength(1);
    expect(appended[0].attrs["data-proxy-adopted"]).toBe("");
    expect(appended[0].textContent).toBe(":root{--x:1}");
  });

  test("空 / 読取り不能な adoptedStyleSheet は出力しない", () => {
    const { doc, appended } = fakeDoc({
      adopted: [
        {
          get cssRules() {
            return [];
          },
        },
        {
          get cssRules(): { cssText: string }[] {
            throw new Error("blocked");
          },
        },
      ],
    });
    expect(() => inlineCssomStyles(doc as never)).not.toThrow();
    expect(appended).toHaveLength(0);
  });
});

// measureDomByteLength（#144）。page.content() で Node ヒープへ全量展開する前に、
// ブラウザ context 内で描画済み DOM の UTF-8 バイト数を概算する DOM 関数。
// 実ブラウザ（page.evaluate）配線はテスト対象外（テスト方針）のため、
// documentElement.outerHTML を持つ document 互換オブジェクトで検証する。
describe("measureDomByteLength（#144）", () => {
  const fakeDoc = (outerHTML: string) =>
    ({ documentElement: { outerHTML } }) as unknown as Document;

  test("ASCII のみは文字数＝UTF-8 バイト数", () => {
    const html = "<html><body>hello</body></html>";
    expect(measureDomByteLength(fakeDoc(html))).toBe(html.length);
  });

  test("マルチバイト文字は UTF-8 バイト数で測る（文字列長より大きい）", () => {
    const html = "<p>あいう</p>"; // 「あいう」は各 3 バイト
    const byteLength = measureDomByteLength(fakeDoc(html));
    expect(byteLength).toBe(new TextEncoder().encode(html).length);
    expect(byteLength).toBeGreaterThan(html.length);
  });

  test("空 DOM は 0 バイト", () => {
    expect(measureDomByteLength(fakeDoc(""))).toBe(0);
  });
});

// domSizeExceedsLimit（#144）。概算バイト数が上限を超えるかの純粋判定。
// readTextWithLimit と同じく「>（厳密超過）」で揃える。
describe("domSizeExceedsLimit（#144）", () => {
  test.each([
    [9, 10, false],
    [10, 10, false], // 上限ちょうどは許可（境界）
    [11, 10, true],
    [0, 10, false],
  ])("byteLength=%p, maxBytes=%p → %p", (byteLength, maxBytes, expected) => {
    expect(domSizeExceedsLimit(byteLength, maxBytes)).toBe(expected);
  });
});
