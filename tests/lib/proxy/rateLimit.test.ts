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
