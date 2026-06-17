/** @jest-environment node */
// 仕様: docs/spec/features/proxy.md §レート制限

import { RateLimiter, RateLimitExceededError } from "@/lib/proxy/rateLimit";

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
});
