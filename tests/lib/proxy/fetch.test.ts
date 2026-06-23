/** @jest-environment node */
// 仕様: docs/spec/features/proxy.md §SSRF 対策 / §POST 中継

import {
  isSsrfBlocked,
  firstBlockedAddress,
  decideSsrfLookup,
  findSsrfCause,
  SsrfBlockedError,
  buildProxyRequestInit,
  DEFAULT_USER_AGENT,
  isRedirectStatus,
  resolveRedirectTarget,
  sameOrigin,
  stripCredentialHeaders,
  nextRedirectMethod,
} from "@/lib/proxy/fetch";

describe("isSsrfBlocked", () => {
  test.each([
    // --- IPv4 ---
    ["127.0.0.1", "loopback"],
    ["127.0.0.2", "loopback range"],
    ["10.0.0.1", "private class A"],
    ["10.255.255.255", "private class A upper"],
    ["172.16.0.1", "private class B lower"],
    ["172.31.255.255", "private class B upper"],
    ["192.168.0.1", "private class C"],
    ["192.168.255.255", "private class C upper"],
    ["169.254.169.254", "cloud metadata"],
    ["169.254.0.1", "link-local"],
    ["0.0.0.0", "unspecified"],
    // --- IPv4 CGNAT 100.64.0.0/10（#130）---
    ["100.64.0.0", "CGNAT lower"],
    ["100.100.50.1", "CGNAT mid"],
    ["100.127.255.255", "CGNAT upper"],
    // --- IPv6（#130）---
    ["::1", "IPv6 loopback"],
    ["::", "IPv6 unspecified"],
    ["fe80::1", "IPv6 link-local"],
    ["febf:ffff::1", "IPv6 link-local upper (fe80::/10)"],
    ["fc00::1", "IPv6 ULA fc00::/7 lower"],
    ["fd12:3456:789a::1", "IPv6 ULA fd00 range"],
    // --- IPv4-mapped IPv6（#130）---
    ["::ffff:127.0.0.1", "IPv4-mapped loopback (dotted)"],
    ["::ffff:169.254.169.254", "IPv4-mapped cloud metadata (dotted)"],
    ["::ffff:7f00:1", "IPv4-mapped loopback (hex)"],
  ])("returns true for %s (%s)", (ip) => {
    expect(isSsrfBlocked(ip)).toBe(true);
  });

  test.each([
    // --- IPv4 ---
    ["1.1.1.1", "public DNS"],
    ["8.8.8.8", "Google DNS"],
    ["93.184.216.34", "example.com"],
    ["172.15.255.255", "just below private class B"],
    ["172.32.0.0", "just above private class B"],
    ["11.0.0.0", "just above private class A"],
    ["192.169.0.0", "just above private class C"],
    ["100.63.255.255", "just below CGNAT"],
    ["100.128.0.0", "just above CGNAT"],
    // --- IPv6 ---
    ["2606:4700:4700::1111", "Cloudflare public IPv6"],
    ["2001:4860:4860::8888", "Google public IPv6"],
    ["fec0::1", "IPv6 site-local just above fe80::/10 (not blocked here)"],
    // --- IPv4-mapped public ---
    ["::ffff:8.8.8.8", "IPv4-mapped public (dotted)"],
  ])("returns false for %s (%s)", (ip) => {
    expect(isSsrfBlocked(ip)).toBe(false);
  });
});

describe("firstBlockedAddress（IP ピン留め検査・#129）", () => {
  // 仕様: docs/spec/features/proxy.md §DNS リバインディング / TOCTOU 対策（IP ピン留め）
  test("全アドレスが公開なら null（接続許可）", () => {
    expect(
      firstBlockedAddress([
        { address: "93.184.216.34" },
        { address: "2606:4700:4700::1111" },
      ])
    ).toBeNull();
  });

  test("1 つでもブロック対象（dual-stack の AAAA が ::1）なら、その IP を返す", () => {
    expect(
      firstBlockedAddress([
        { address: "93.184.216.34" }, // 公開 A
        { address: "::1" }, // 危険な AAAA
      ])
    ).toBe("::1");
  });

  test("IPv4 がプライベートなら、その IP を返す", () => {
    expect(firstBlockedAddress([{ address: "127.0.0.1" }])).toBe("127.0.0.1");
  });

  test("空配列は null（呼び出し側が解決失敗として扱う）", () => {
    expect(firstBlockedAddress([])).toBeNull();
  });
});

describe("decideSsrfLookup（connect.lookup ピン留め判定・#129）", () => {
  // 仕様: docs/spec/features/proxy.md §DNS リバインディング / TOCTOU 対策（IP ピン留め）
  // connect.lookup は接続時に呼ばれる。ここで解決された IP がブロック対象なら、
  // 事前検査を通過していても（= リバインディングで応答 IP がすり替わっても）遮断する。

  test("リバインディング: 接続時の解決がループバックなら blocked（事前検査が公開でも遮断）", () => {
    // 事前検査時は公開 IP だったホストが、接続時の再解決で 127.0.0.1 を返すケース。
    expect(
      decideSsrfLookup([{ address: "127.0.0.1", family: 4 }], true)
    ).toEqual({ kind: "blocked", address: "127.0.0.1" });
  });

  test("dual-stack で AAAA が ::1 なら blocked（全件検査）", () => {
    expect(
      decideSsrfLookup(
        [
          { address: "93.184.216.34", family: 4 },
          { address: "::1", family: 6 },
        ],
        true
      )
    ).toEqual({ kind: "blocked", address: "::1" });
  });

  test("all=true: 全件が公開なら検査済み配列をそのまま返す（再解決せず接続＝ピン留め）", () => {
    const addrs = [
      { address: "93.184.216.34", family: 4 },
      { address: "2606:4700:4700::1111", family: 6 },
    ];
    expect(decideSsrfLookup(addrs, true)).toEqual({
      kind: "all",
      addresses: addrs,
    });
  });

  test("all=false: 全件が公開なら先頭アドレスを単一形式で返す", () => {
    expect(
      decideSsrfLookup([{ address: "93.184.216.34", family: 4 }], false)
    ).toEqual({ kind: "single", address: "93.184.216.34", family: 4 });
  });

  test("空配列は empty（解決失敗）", () => {
    expect(decideSsrfLookup([], true)).toEqual({ kind: "empty" });
  });
});

describe("findSsrfCause（403 伝播・#129）", () => {
  // undici は connect.lookup の例外を TypeError の cause に包むため、ネスト cause から
  // SsrfBlockedError を取り出せること（→ 呼び出し側が 403 にマップ）を検証する。
  test("ネストした cause 連鎖から SsrfBlockedError を取り出す", () => {
    const ssrf = new SsrfBlockedError("127.0.0.1");
    const wrapped = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("connect"), { cause: ssrf }),
    });
    expect(findSsrfCause(wrapped)).toBe(ssrf);
  });

  test("SSRF 由来でないエラーは null（502 経路へ）", () => {
    const other = Object.assign(new TypeError("fetch failed"), {
      cause: new Error("ECONNREFUSED"),
    });
    expect(findSsrfCause(other)).toBeNull();
  });

  test("直接 SsrfBlockedError でも取り出せる", () => {
    const ssrf = new SsrfBlockedError("::1");
    expect(findSsrfCause(ssrf)).toBe(ssrf);
  });
});

describe("buildProxyRequestInit", () => {
  test("defaults_to_get_without_body_and_keeps_base_headers", () => {
    const init = buildProxyRequestInit();
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
    expect(init.duplex).toBeUndefined();
    const headers = init.headers as Record<string, string>;
    expect(headers["User-Agent"]).toBe(DEFAULT_USER_AGENT);
    expect(headers["Accept-Encoding"]).toBe("identity");
  });

  describe("既定 User-Agent（#41）", () => {
    // 仕様: docs/spec/features/proxy.md §ターゲットへ送る既定 User-Agent
    // process.env を変えるテストは前後で復元する（テストルール）。
    const ORIGINAL_UA = process.env.PROXY_USER_AGENT;
    afterEach(() => {
      if (ORIGINAL_UA === undefined) delete process.env.PROXY_USER_AGENT;
      else process.env.PROXY_USER_AGENT = ORIGINAL_UA;
    });

    test("既定 UA は現代ブラウザ相当（Chrome 系）の文字列である", () => {
      expect(DEFAULT_USER_AGENT).toMatch(/^Mozilla\/5\.0 /);
      expect(DEFAULT_USER_AGENT).toContain("Chrome/");
      expect(DEFAULT_USER_AGENT).not.toContain("web-proxy");
    });

    test("PROXY_USER_AGENT が設定されていれば既定 UA に用いる", () => {
      process.env.PROXY_USER_AGENT = "CustomAgent/9.9";
      const headers = buildProxyRequestInit().headers as Record<string, string>;
      expect(headers["User-Agent"]).toBe("CustomAgent/9.9");
    });

    test("PROXY_USER_AGENT が空文字なら既定 UA にフォールバックする", () => {
      process.env.PROXY_USER_AGENT = "";
      const headers = buildProxyRequestInit().headers as Record<string, string>;
      expect(headers["User-Agent"]).toBe(DEFAULT_USER_AGENT);
    });

    test("呼び出し側が options.headers で渡した User-Agent が優先される", () => {
      process.env.PROXY_USER_AGENT = "EnvAgent/1.0";
      const headers = buildProxyRequestInit({
        headers: { "User-Agent": "CallerAgent/2.0" },
      }).headers as Record<string, string>;
      expect(headers["User-Agent"]).toBe("CallerAgent/2.0");
    });
  });

  describe("ヘッダーのケース非依存マージ（#43）", () => {
    // 仕様: docs/spec/features/proxy.md §ターゲットへ送る既定 User-Agent §呼び出し側の優先
    // HTTP ヘッダー名はケース非依存（RFC 7230）。非 GET 中継の relayRequestHeaders は
    // 受信ヘッダーを小文字キー（user-agent）で返すため、既定の大文字 User-Agent と
    // 二重化させず呼び出し側を後勝ちにする。

    // 同名ヘッダーを大文字小文字を無視して数える。
    const countCaseInsensitive = (
      headers: Record<string, string>,
      name: string
    ) =>
      Object.keys(headers).filter((k) => k.toLowerCase() === name.toLowerCase())
        .length;

    test("小文字 user-agent（relay 由来）が既定 User-Agent を上書きし二重化しない", () => {
      const headers = buildProxyRequestInit({
        method: "POST",
        headers: { "user-agent": "FromRelay/1.0" },
      }).headers as Record<string, string>;
      // 既定の大文字キーは残らず、呼び出し側の値だけが残る。
      expect(countCaseInsensitive(headers, "user-agent")).toBe(1);
      expect(headers["User-Agent"]).toBeUndefined();
      expect(headers["user-agent"]).toBe("FromRelay/1.0");
    });

    test("マージ結果に大文字小文字違いの同名ヘッダーが重複しない", () => {
      const headers = buildProxyRequestInit({
        method: "POST",
        headers: { "user-agent": "R/1", "Content-Type": "text/plain" },
      }).headers as Record<string, string>;
      const lowerKeys = Object.keys(headers).map((k) => k.toLowerCase());
      // 小文字化したキー集合に重複がない（= ケース違いの二重化がない）。
      expect(lowerKeys.length).toBe(new Set(lowerKeys).size);
      expect(countCaseInsensitive(headers, "user-agent")).toBe(1);
    });
  });

  test("forwards_post_method_with_stream_body_and_sets_duplex_half", () => {
    const body = new ReadableStream();
    const init = buildProxyRequestInit({ method: "POST", body });
    expect(init.method).toBe("POST");
    expect(init.body).toBe(body);
    // ReadableStream ボディには duplex: "half" が必須
    expect(init.duplex).toBe("half");
  });

  test("forwards_request_content_type_header_merged_over_base_headers", () => {
    const init = buildProxyRequestInit({
      method: "POST",
      body: "a=1",
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    const headers = init.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("application/x-www-form-urlencoded");
    // 既定ヘッダーは維持される
    expect(headers["Accept-Encoding"]).toBe("identity");
  });

  test("omits_duplex_for_non_stream_body", () => {
    const init = buildProxyRequestInit({ method: "POST", body: "a=1" });
    expect(init.body).toBe("a=1");
    expect(init.duplex).toBeUndefined();
  });

  test("drops_body_for_get_even_if_provided", () => {
    const init = buildProxyRequestInit({ method: "GET", body: "a=1" });
    expect(init.body).toBeUndefined();
    expect(init.duplex).toBeUndefined();
  });
});

// 仕様: docs/spec/features/proxy.md §リダイレクト追従（#26 / #42）
describe("リダイレクト追従のヘルパー（#26）", () => {
  describe("isRedirectStatus", () => {
    test.each([301, 302, 303, 307, 308])("%i はリダイレクト", (s) => {
      expect(isRedirectStatus(s)).toBe(true);
    });
    test.each([200, 204, 304, 400, 500])("%i はリダイレクトでない", (s) => {
      expect(isRedirectStatus(s)).toBe(false);
    });
  });

  describe("resolveRedirectTarget", () => {
    test("相対パスは現在 URL 基準で絶対化される", () => {
      expect(resolveRedirectTarget("/next", "https://a.com/x/y")).toBe(
        "https://a.com/next"
      );
    });
    test("絶対 URL はそのまま採用される", () => {
      expect(resolveRedirectTarget("https://b.com/p", "https://a.com/")).toBe(
        "https://b.com/p"
      );
    });
    test("不正な base では null を返す", () => {
      expect(resolveRedirectTarget("/next", "not a url")).toBeNull();
    });
  });

  describe("sameOrigin", () => {
    test("同一スキーム・ホスト・ポートは true", () => {
      expect(sameOrigin("https://a.com/x", "https://a.com/y")).toBe(true);
    });
    test("既定ポートの明示有無は同一オリジン", () => {
      expect(sameOrigin("https://a.com", "https://a.com:443/z")).toBe(true);
    });
    test("スキーム差は別オリジン", () => {
      expect(sameOrigin("https://a.com", "http://a.com")).toBe(false);
    });
    test("ホスト差は別オリジン", () => {
      expect(sameOrigin("https://a.com", "https://b.com")).toBe(false);
    });
    test("パース不能は安全側で false（別オリジン扱い）", () => {
      expect(sameOrigin("https://a.com", "not a url")).toBe(false);
    });
  });

  describe("stripCredentialHeaders", () => {
    test("Authorization / Cookie をケース非依存で除去し他は残す", () => {
      const stripped = stripCredentialHeaders({
        "User-Agent": "UA",
        Authorization: "Bearer x",
        cookie: "a=1",
        "Accept-Encoding": "identity",
      });
      expect(stripped).toEqual({
        "User-Agent": "UA",
        "Accept-Encoding": "identity",
      });
    });
    test("元のオブジェクトを破壊しない", () => {
      const src = { Cookie: "a=1", "X-Keep": "1" };
      stripCredentialHeaders(src);
      expect(src).toEqual({ Cookie: "a=1", "X-Keep": "1" });
    });
  });

  describe("nextRedirectMethod", () => {
    test.each([
      [301, "POST", false, "GET", false],
      [302, "GET", false, "GET", false],
      [303, "POST", true, "GET", false],
      [307, "POST", true, "POST", true],
      [307, "POST", false, "GET", false], // 再送不可ボディは安全側で GET 降格
      [308, "PUT", true, "PUT", true],
      [308, "GET", false, "GET", false],
    ])(
      "status=%i method=%s replayable=%s -> %s sendBody=%s",
      (status, method, replayable, expMethod, expSend) => {
        expect(
          nextRedirectMethod(
            status as number,
            method as string,
            replayable as boolean
          )
        ).toEqual({ method: expMethod, sendBody: expSend });
      }
    );
  });
});
