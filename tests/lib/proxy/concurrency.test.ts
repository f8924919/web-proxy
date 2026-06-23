/** @jest-environment node */
// 仕様: docs/spec/features/proxy.md §同時接続数の制限（#133）

import {
  ConcurrencyLimiter,
  ConcurrencyLimitExceededError,
  concurrencyConfigFromEnv,
} from "@/lib/proxy/concurrency";

describe("ConcurrencyLimiter", () => {
  test("上限内の acquire は解放関数を返す", () => {
    const limiter = new ConcurrencyLimiter(10, 10);
    const release = limiter.acquire("1.2.3.4");
    expect(typeof release).toBe("function");
  });

  test("IP 単位の上限を超えると ip スコープで throw する", () => {
    const limiter = new ConcurrencyLimiter(10, 2);
    limiter.acquire("1.2.3.4");
    limiter.acquire("1.2.3.4");
    try {
      limiter.acquire("1.2.3.4");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ConcurrencyLimitExceededError);
      expect((err as ConcurrencyLimitExceededError).scope).toBe("ip");
    }
  });

  test("グローバル上限を超えると global スコープで throw する", () => {
    const limiter = new ConcurrencyLimiter(2, 10);
    limiter.acquire("1.1.1.1");
    limiter.acquire("2.2.2.2");
    try {
      limiter.acquire("3.3.3.3");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ConcurrencyLimitExceededError);
      expect((err as ConcurrencyLimitExceededError).scope).toBe("global");
    }
  });

  test("解放するとスロットが空き、再度 acquire できる", () => {
    const limiter = new ConcurrencyLimiter(10, 1);
    const release = limiter.acquire("1.2.3.4");
    expect(() => limiter.acquire("1.2.3.4")).toThrow(
      ConcurrencyLimitExceededError
    );
    release();
    expect(() => limiter.acquire("1.2.3.4")).not.toThrow();
  });

  test("解放関数は冪等（複数回呼んでも 1 回だけ減算）", () => {
    const limiter = new ConcurrencyLimiter(2, 2);
    const release = limiter.acquire("1.2.3.4");
    release();
    release(); // 二重解放してもカウンタを過剰に戻さない
    limiter.acquire("1.2.3.4");
    limiter.acquire("1.2.3.4");
    // per-IP 上限 2 に達しているので次は throw
    expect(() => limiter.acquire("1.2.3.4")).toThrow(
      ConcurrencyLimitExceededError
    );
  });

  test("IP ごとに同時数が独立している", () => {
    const limiter = new ConcurrencyLimiter(10, 1);
    limiter.acquire("1.1.1.1");
    expect(() => limiter.acquire("2.2.2.2")).not.toThrow();
  });

  test("active / size が現在の同時数を反映する", () => {
    const limiter = new ConcurrencyLimiter(10, 10);
    const r1 = limiter.acquire("1.1.1.1");
    limiter.acquire("2.2.2.2");
    expect(limiter.active).toBe(2);
    expect(limiter.size).toBe(2);
    r1();
    expect(limiter.active).toBe(1);
    expect(limiter.size).toBe(1); // 0 になった IP エントリは削除される
  });

  test("グローバルが空いていても IP 上限が優先して効く", () => {
    const limiter = new ConcurrencyLimiter(100, 1);
    limiter.acquire("1.2.3.4");
    expect(() => limiter.acquire("1.2.3.4")).toThrow(
      ConcurrencyLimitExceededError
    );
  });
});

describe("concurrencyConfigFromEnv", () => {
  test("未設定なら既定 512 / 64", () => {
    expect(concurrencyConfigFromEnv({})).toEqual({
      maxGlobal: 512,
      maxPerIp: 64,
    });
  });

  test("環境変数で上書きできる", () => {
    expect(
      concurrencyConfigFromEnv({
        PROXY_MAX_CONCURRENT: "100",
        PROXY_MAX_CONCURRENT_PER_IP: "8",
      })
    ).toEqual({ maxGlobal: 100, maxPerIp: 8 });
  });

  test("正の整数以外は既定値にフォールバックする", () => {
    expect(
      concurrencyConfigFromEnv({
        PROXY_MAX_CONCURRENT: "0",
        PROXY_MAX_CONCURRENT_PER_IP: "abc",
      })
    ).toEqual({ maxGlobal: 512, maxPerIp: 64 });
  });
});
