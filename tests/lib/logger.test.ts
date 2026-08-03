/** @jest-environment node */
// 仕様: docs/spec/features/proxy.md §エラーログとプライバシー（機微 URL のマスキング・#138）

import {
  logLevelFromEnv,
  maskSensitive,
  formatError,
  logError,
} from "@/lib/logger";

describe("logLevelFromEnv（#138）", () => {
  test("未設定なら既定 error", () => {
    expect(logLevelFromEnv({})).toBe("error");
  });

  test("有効なレベルはそのまま返す", () => {
    for (const lv of ["silent", "error", "warn", "info", "debug"] as const) {
      expect(logLevelFromEnv({ PROXY_LOG_LEVEL: lv })).toBe(lv);
    }
  });

  test("大文字・前後空白は正規化して受理する", () => {
    expect(logLevelFromEnv({ PROXY_LOG_LEVEL: " DEBUG " })).toBe("debug");
  });

  test("未知値・空文字は既定 error にフォールバック", () => {
    expect(logLevelFromEnv({ PROXY_LOG_LEVEL: "verbose" })).toBe("error");
    expect(logLevelFromEnv({ PROXY_LOG_LEVEL: "" })).toBe("error");
  });
});

describe("maskSensitive（#138）", () => {
  test("URL（scheme://…）を [redacted-url] へ置換する", () => {
    expect(
      maskSensitive("failed to fetch https://secret.example.com/path?q=1 now")
    ).toBe("failed to fetch [redacted-url] now");
  });

  test("IPv4 を [redacted-ip] へ置換する", () => {
    expect(maskSensitive("Blocked SSRF target: 169.254.169.254")).toBe(
      "Blocked SSRF target: [redacted-ip]"
    );
  });

  test("IPv6 を [redacted-ip] へ置換する", () => {
    const masked = maskSensitive("connect to fe80::1ff:fe23:4567:890a failed");
    expect(masked).toContain("[redacted-ip]");
    expect(masked).not.toContain("fe80");
  });

  test("IPv6 圧縮形（先頭 :: のループバック等）も redact する", () => {
    expect(maskSensitive("Blocked SSRF target: ::1")).toBe(
      "Blocked SSRF target: [redacted-ip]"
    );
    expect(maskSensitive("Blocked SSRF target: 2001:db8::1")).toBe(
      "Blocked SSRF target: [redacted-ip]"
    );
  });

  test("素のホスト名（ドメイン）を [redacted-host] へ置換する", () => {
    expect(maskSensitive("getaddrinfo ENOTFOUND sub.example.com")).toBe(
      "getaddrinfo ENOTFOUND [redacted-host]"
    );
  });

  test("機微トークンを含まない文字列はそのまま返す", () => {
    expect(maskSensitive("Proxy fetch timed out or target unreachable")).toBe(
      "Proxy fetch timed out or target unreachable"
    );
  });
});

describe("formatError（#138）", () => {
  test("name（クラス名）は残し message は redact する", () => {
    const err = new TypeError("fetch failed for https://a.example.com/x");
    expect(formatError(err)).toBe("TypeError: fetch failed for [redacted-url]");
  });

  test("cause（ネイティブ fetch のホスト混入）も redact する", () => {
    const err = new TypeError("fetch failed");
    (err as Error & { cause?: unknown }).cause = new Error(
      "getaddrinfo ENOTFOUND db.internal.example"
    );
    const out = formatError(err);
    expect(out).toContain("[redacted-host]");
    expect(out).not.toContain("db.internal.example");
  });

  test("多段の cause 連鎖を辿って根本原因まで出す（#236）", () => {
    // 上流 fetch 失敗は FetchTimeoutError → TypeError: fetch failed →
    // ランタイム側の実エラー、と多段になる。1 段だけの展開では根本原因が出ない。
    const root = new Error("invalid onRequestStart method");
    root.name = "InvalidArgumentError";
    const mid = new TypeError("fetch failed");
    (mid as Error & { cause?: unknown }).cause = root;
    const top = new Error("Proxy fetch timed out or target unreachable");
    top.name = "FetchTimeoutError";
    (top as Error & { cause?: unknown }).cause = mid;

    const out = formatError(top);
    expect(out).toContain("FetchTimeoutError");
    expect(out).toContain("TypeError");
    expect(out).toContain("InvalidArgumentError");
    expect(out).toContain("invalid onRequestStart method");
  });

  test("cause が Error でなければそこで連鎖を打ち切る（#236）", () => {
    const deeper = new Error("should-not-appear");
    const nonError = { toString: () => "plain-cause", cause: deeper };
    const top = new Error("top");
    (top as Error & { cause?: unknown }).cause = nonError;

    const out = formatError(top);
    expect(out).toContain("plain-cause");
    expect(out).not.toContain("should-not-appear");
  });

  test("cause 連鎖が循環していても停止する（#236）", () => {
    const a = new Error("a");
    const b = new Error("b");
    (a as Error & { cause?: unknown }).cause = b;
    (b as Error & { cause?: unknown }).cause = a;
    expect(() => formatError(a)).not.toThrow();
  });

  test("cause 連鎖は 5 段で打ち切る（#236）", () => {
    // 6 段目（深さ 6 の message）は出力に現れない。
    let err = new Error("depth-6");
    for (let i = 5; i >= 0; i--) {
      const outer = new Error(`depth-${i}`);
      (outer as Error & { cause?: unknown }).cause = err;
      err = outer;
    }
    const out = formatError(err);
    expect(out).toContain("depth-0");
    expect(out).toContain("depth-5");
    expect(out).not.toContain("depth-6");
  });

  test("既定ではスタックを含めない（1 行）", () => {
    const err = new Error("boom https://x.example.com");
    expect(formatError(err)).not.toContain("\n");
  });

  test("includeStack 指定時のみスタックを添える", () => {
    const err = new Error("boom");
    expect(formatError(err, true)).toContain("\n");
  });

  test("Error 以外も文字列化して redact する", () => {
    expect(formatError("raw https://leak.example.com")).toBe(
      "raw [redacted-url]"
    );
  });
});

describe("logError（レベルゲート + マスキング・#138）", () => {
  const ORIGINAL = process.env.PROXY_LOG_LEVEL;
  let spy: jest.SpyInstance;

  beforeEach(() => {
    spy = jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    spy.mockRestore();
    if (ORIGINAL === undefined) delete process.env.PROXY_LOG_LEVEL;
    else process.env.PROXY_LOG_LEVEL = ORIGINAL;
  });

  test("silent では一切出力しない", () => {
    process.env.PROXY_LOG_LEVEL = "silent";
    logError("[proxy/browse]", new Error("x https://a.example.com"));
    expect(spy).not.toHaveBeenCalled();
  });

  test("既定（error）では出力し、機微 URL を redact する", () => {
    delete process.env.PROXY_LOG_LEVEL;
    logError("[proxy/browse]", new Error("boom https://secret.example.com/p"));
    expect(spy).toHaveBeenCalledTimes(1);
    const [label, formatted] = spy.mock.calls[0];
    expect(label).toBe("[proxy/browse]");
    expect(String(formatted)).toContain("[redacted-url]");
    expect(String(formatted)).not.toContain("secret.example.com");
  });

  test("error ではスタックなし・debug ではスタック付き", () => {
    process.env.PROXY_LOG_LEVEL = "error";
    logError("[proxy/asset]", new Error("boom"));
    expect(String(spy.mock.calls[0][1])).not.toContain("\n");

    spy.mockClear();
    process.env.PROXY_LOG_LEVEL = "debug";
    logError("[proxy/asset]", new Error("boom"));
    expect(String(spy.mock.calls[0][1])).toContain("\n");
  });
});
