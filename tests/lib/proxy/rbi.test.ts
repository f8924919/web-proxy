/** @jest-environment node */
// 設計: docs/arch/proxy.md §src/lib/proxy/rbi.ts（設計案・#193。実装はモック PoC のみ）

import {
  rbiBackendFromEnv,
  shouldUseRbi,
  shouldPromoteToRbi,
  RbiGuard,
  RbiSessionLimiter,
  MockRbiBackend,
} from "@/lib/proxy/rbi";

const HTML = "text/html; charset=utf-8";

describe("rbiBackendFromEnv", () => {
  test("未設定なら off（既定）", () => {
    expect(rbiBackendFromEnv({}).backend).toBe("off");
  });

  test("不正値は off へフォールバック（安全側）", () => {
    expect(rbiBackendFromEnv({ RBI_BACKEND: "bogus" }).backend).toBe("off");
  });

  test("mock は RBI_BASE_URL 無しでも有効（既定 URL を持つ）", () => {
    const config = rbiBackendFromEnv({ RBI_BACKEND: "mock" });
    expect(config.backend).toBe("mock");
    expect(config.baseUrl).toBeTruthy();
  });

  test.each(["kasm", "neko"] as const)(
    "%s は RBI_BASE_URL が無ければ off へフォールバック（安全側）",
    (backend) => {
      expect(rbiBackendFromEnv({ RBI_BACKEND: backend }).backend).toBe("off");
      expect(
        rbiBackendFromEnv({
          RBI_BACKEND: backend,
          RBI_BASE_URL: "https://rbi.example.com",
        }).backend
      ).toBe(backend);
    }
  );

  test("RBI_FORCE_HOSTS をカンマ区切りで解釈する（前後空白・先頭ドット・小文字化は PROXY_BROWSER_HOSTS と同じ規則）", () => {
    const config = rbiBackendFromEnv({
      RBI_BACKEND: "mock",
      RBI_FORCE_HOSTS: " Example.COM , .foo.jp ,, ",
    });
    expect(config.forceHosts).toEqual(["example.com", "foo.jp"]);
  });

  test("RBI_MAX_SESSIONS / RBI_SESSION_TTL_MS の既定は 5 / 15 分", () => {
    const config = rbiBackendFromEnv({ RBI_BACKEND: "mock" });
    expect(config.maxSessions).toBe(5);
    expect(config.sessionTtlMs).toBe(15 * 60 * 1000);
  });

  test("RBI_MAX_SESSIONS / RBI_SESSION_TTL_MS を数値として解釈し、不正値は既定へ", () => {
    const config = rbiBackendFromEnv({
      RBI_BACKEND: "mock",
      RBI_MAX_SESSIONS: "10",
      RBI_SESSION_TTL_MS: "60000",
    });
    expect(config.maxSessions).toBe(10);
    expect(config.sessionTtlMs).toBe(60000);
    const bad = rbiBackendFromEnv({
      RBI_BACKEND: "mock",
      RBI_MAX_SESSIONS: "-1",
      RBI_SESSION_TTL_MS: "abc",
    });
    expect(bad.maxSessions).toBe(5);
    expect(bad.sessionTtlMs).toBe(15 * 60 * 1000);
  });
});

describe("shouldUseRbi", () => {
  const config = rbiBackendFromEnv({
    RBI_BACKEND: "mock",
    RBI_FORCE_HOSTS: "example.com",
  });

  test("backend が off なら常に false", () => {
    const off = rbiBackendFromEnv({});
    expect(shouldUseRbi("https://example.com/", off)).toBe(false);
  });

  test("forceHosts のホストは true（サブドメイン接尾辞一致を含む）", () => {
    expect(shouldUseRbi("https://example.com/page", config)).toBe(true);
    expect(shouldUseRbi("https://www.example.com/", config)).toBe(true);
  });

  test("forceHosts 外のホストは false（部分一致で誤爆しない）", () => {
    expect(shouldUseRbi("https://other.jp/", config)).toBe(false);
    expect(shouldUseRbi("https://notexample.com/", config)).toBe(false);
  });

  test("URL が不正なら false（安全側）", () => {
    expect(shouldUseRbi("not a url", config)).toBe(false);
  });
});

describe("shouldPromoteToRbi", () => {
  const config = rbiBackendFromEnv({ RBI_BACKEND: "mock" });
  const challengeHtml =
    "<html><body>Checking your browser before accessing.</body></html>";
  const normalHtml =
    "<html><body><h1>ようこそ</h1><p>これは通常のコンテンツです。十分な本文があります。</p></body></html>";

  test("ブラウザティア出力にチャレンジが残っていれば true（shouldPromoteToBrowser の再利用）", () => {
    expect(
      shouldPromoteToRbi(
        { html: challengeHtml, status: 200, contentType: HTML },
        config
      )
    ).toBe(true);
  });

  test("ブラウザティアで解消済み（通常応答）なら false", () => {
    expect(
      shouldPromoteToRbi(
        { html: normalHtml, status: 200, contentType: HTML },
        config
      )
    ).toBe(false);
  });

  test("backend が off なら常に false", () => {
    const off = rbiBackendFromEnv({});
    expect(
      shouldPromoteToRbi(
        { html: challengeHtml, status: 200, contentType: HTML },
        off
      )
    ).toBe(false);
  });
});

describe("RbiGuard", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("同一 host+path はウィンドウ内で 1 回のみ昇格可（クエリは無視）", () => {
    const guard = new RbiGuard(60_000);
    expect(guard.tryPromote(new URL("https://a.com/page?x=1"))).toBe(true);
    expect(guard.tryPromote(new URL("https://a.com/page?x=2"))).toBe(false);
  });

  test("別 host / 別 path は独立に昇格できる", () => {
    const guard = new RbiGuard(60_000);
    expect(guard.tryPromote(new URL("https://a.com/page"))).toBe(true);
    expect(guard.tryPromote(new URL("https://b.com/page"))).toBe(true);
    expect(guard.tryPromote(new URL("https://a.com/other"))).toBe(true);
  });

  test("ウィンドウ経過後は再昇格できる", () => {
    let now = 1_000_000;
    jest.spyOn(Date, "now").mockImplementation(() => now);
    const guard = new RbiGuard(60_000);
    expect(guard.tryPromote(new URL("https://a.com/page"))).toBe(true);
    now += 60_001;
    expect(guard.tryPromote(new URL("https://a.com/page"))).toBe(true);
  });
});

describe("RbiSessionLimiter", () => {
  test("上限までは acquire でき、超えると null", () => {
    const limiter = new RbiSessionLimiter(2);
    const r1 = limiter.tryAcquire();
    const r2 = limiter.tryAcquire();
    expect(r1).not.toBeNull();
    expect(r2).not.toBeNull();
    expect(limiter.tryAcquire()).toBeNull();
  });

  test("release でスロットが空く", () => {
    const limiter = new RbiSessionLimiter(1);
    const release = limiter.tryAcquire();
    expect(release).not.toBeNull();
    expect(limiter.tryAcquire()).toBeNull();
    release!();
    expect(limiter.tryAcquire()).not.toBeNull();
  });

  test("release は冪等（二重解放で二重に空かない）", () => {
    const limiter = new RbiSessionLimiter(2);
    const release = limiter.tryAcquire()!;
    limiter.tryAcquire();
    release();
    release();
    expect(limiter.tryAcquire()).not.toBeNull();
    expect(limiter.tryAcquire()).toBeNull();
  });
});

describe("MockRbiBackend", () => {
  const baseUrl = "https://rbi.example.com";

  test("sessionUrl は RBI_BASE_URL と同一オリジン（オープンリダイレクト防止の要件）", async () => {
    const backend = new MockRbiBackend(baseUrl);
    const { sessionUrl } = await backend.createSession(
      "https://target.example/"
    );
    expect(new URL(sessionUrl).origin).toBe(new URL(baseUrl).origin);
  });

  test("sessionId は推測不能な長さを持ち、sessionUrl に含まれる", async () => {
    const backend = new MockRbiBackend(baseUrl);
    const { sessionId, sessionUrl } = await backend.createSession(
      "https://target.example/"
    );
    expect(sessionId.length).toBeGreaterThanOrEqual(16);
    expect(sessionUrl).toContain(sessionId);
  });

  test("セッションごとに sessionId が異なる", async () => {
    const backend = new MockRbiBackend(baseUrl);
    const a = await backend.createSession("https://target.example/");
    const b = await backend.createSession("https://target.example/");
    expect(a.sessionId).not.toBe(b.sessionId);
  });

  test("destroySession は既知の sessionId を解決し、セッションを追跡から外す", async () => {
    const backend = new MockRbiBackend(baseUrl);
    const { sessionId } = await backend.createSession(
      "https://target.example/"
    );
    expect(backend.activeSessionCount()).toBe(1);
    await backend.destroySession(sessionId);
    expect(backend.activeSessionCount()).toBe(0);
  });
});
