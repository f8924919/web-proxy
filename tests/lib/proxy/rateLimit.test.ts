/** @jest-environment node */
// 仕様: docs/spec/features/proxy.md §レート制限

import {
  RateLimiter,
  RateLimitExceededError,
  pageRateLimiter,
  assetRateLimiter,
} from "@/lib/proxy/rateLimit";

describe("RateLimiter", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test("60 回以内のリクエストは通過する", () => {
    const limiter = new RateLimiter();
    expect(() => {
      for (let i = 0; i < 60; i++) limiter.check("1.2.3.4");
    }).not.toThrow();
  });

  test("61 回目で RateLimitExceededError を throw する", () => {
    const limiter = new RateLimiter();
    for (let i = 0; i < 60; i++) limiter.check("1.2.3.4");
    expect(() => limiter.check("1.2.3.4")).toThrow(RateLimitExceededError);
  });

  test("1 分経過後はカウンターがリセットされ通過する", () => {
    const limiter = new RateLimiter();
    for (let i = 0; i < 60; i++) limiter.check("1.2.3.4");

    jest.advanceTimersByTime(61_000);

    expect(() => limiter.check("1.2.3.4")).not.toThrow();
  });

  test("IP ごとにカウントが独立している", () => {
    const limiter = new RateLimiter();
    for (let i = 0; i < 60; i++) limiter.check("1.2.3.4");

    expect(() => limiter.check("5.6.7.8")).not.toThrow();
  });

  test("上限はコンストラクタ引数で設定できる", () => {
    const limiter = new RateLimiter(2);
    expect(() => {
      limiter.check("1.2.3.4");
      limiter.check("1.2.3.4");
    }).not.toThrow();
    expect(() => limiter.check("1.2.3.4")).toThrow(RateLimitExceededError);
  });

  // #132: 偽装 IP 等で多数の異なるキーが流入しても、ウィンドウ外になった空エントリは
  // 削除され store が肥大しないこと（windowMs ごとに間引いて走査）。
  test("ウィンドウ経過後の空エントリは eviction され store が肥大しない", () => {
    const limiter = new RateLimiter(60, 60_000);
    for (let i = 0; i < 100; i++) limiter.check(`10.0.0.${i}`);
    expect(limiter.size).toBe(100);

    // ウィンドウを超えて時間を進め、別 IP で check すると eviction が走る。
    jest.advanceTimersByTime(61_000);
    limiter.check("9.9.9.9");

    // 旧 100 エントリは全タイムスタンプがウィンドウ外となり削除され、新規 1 件のみ残る。
    expect(limiter.size).toBe(1);
  });

  test("ウィンドウ内にアクセスのあるエントリは eviction されない", () => {
    const limiter = new RateLimiter(60, 60_000);
    limiter.check("1.1.1.1");
    jest.advanceTimersByTime(61_000);
    limiter.check("1.1.1.1"); // 同一 IP を再アクセス（eviction も走る）
    expect(limiter.size).toBe(1);
  });
});

describe("用途別レートリミッタ", () => {
  test("pageRateLimiter は 60 req/分（61 回目で超過）", () => {
    for (let i = 0; i < 60; i++) pageRateLimiter.check("page-ip");
    expect(() => pageRateLimiter.check("page-ip")).toThrow(
      RateLimitExceededError
    );
  });

  test("assetRateLimiter は 600 req/分（60 を超えても通過、601 回目で超過）", () => {
    for (let i = 0; i < 600; i++) assetRateLimiter.check("asset-ip");
    expect(() => assetRateLimiter.check("asset-ip")).toThrow(
      RateLimitExceededError
    );
  });

  test("ページ用とアセット用はバケットが独立している", () => {
    for (let i = 0; i < 60; i++) pageRateLimiter.check("shared-ip");
    // 同じ IP でもアセット枠は消費されていない
    expect(() => assetRateLimiter.check("shared-ip")).not.toThrow();
  });
});
