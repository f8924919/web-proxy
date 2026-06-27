/** @jest-environment node */
// 仕様: docs/spec/features/proxy.md §アセット中継の上流 429 リトライ（Retry-After 尊重・#166）

import {
  parseRetryAfter,
  assetRetryConfigFromEnv,
  computeRetryWaitMs,
  DEFAULT_RETRY_WAIT_MS,
} from "@/lib/proxy/retry";

const NOW = 1_700_000_000_000; // 固定の現在時刻（ms）

describe("parseRetryAfter", () => {
  test("秒数形式は ms に変換する", () => {
    expect(parseRetryAfter("1", NOW)).toBe(1000);
    expect(parseRetryAfter("0", NOW)).toBe(0);
    expect(parseRetryAfter("30", NOW)).toBe(30_000);
  });

  test("前後空白を許容する", () => {
    expect(parseRetryAfter("  2  ", NOW)).toBe(2000);
  });

  test("HTTP-date 形式は now との差（ms）を返す", () => {
    const future = new Date(NOW + 5000).toUTCString(); // 5 秒後
    // toUTCString は秒精度なので 0〜5000ms の範囲に収まる
    const got = parseRetryAfter(future, NOW);
    expect(got).not.toBeNull();
    expect(got).toBeGreaterThanOrEqual(0);
    expect(got).toBeLessThanOrEqual(5000);
  });

  test("過去日時は 0（負値にしない）", () => {
    const past = new Date(NOW - 10_000).toUTCString();
    expect(parseRetryAfter(past, NOW)).toBe(0);
  });

  test("欠落（null）・空文字・解析不能は null", () => {
    expect(parseRetryAfter(null, NOW)).toBeNull();
    expect(parseRetryAfter("", NOW)).toBeNull();
    expect(parseRetryAfter("   ", NOW)).toBeNull();
    expect(parseRetryAfter("soon", NOW)).toBeNull();
  });

  test("負の秒数は null（不正値）", () => {
    expect(parseRetryAfter("-5", NOW)).toBeNull();
  });

  test("非整数の秒数は null（不正値）", () => {
    expect(parseRetryAfter("1.5", NOW)).toBeNull();
  });
});

describe("assetRetryConfigFromEnv", () => {
  test("未設定は既定（attempts=1 / maxWaitMs=2000）", () => {
    expect(assetRetryConfigFromEnv({})).toEqual({
      attempts: 1,
      maxWaitMs: 2000,
    });
  });

  test("正の整数を反映する", () => {
    expect(
      assetRetryConfigFromEnv({
        PROXY_ASSET_RETRY_ATTEMPTS: "2",
        PROXY_ASSET_RETRY_MAX_WAIT_MS: "3000",
      })
    ).toEqual({ attempts: 2, maxWaitMs: 3000 });
  });

  test("attempts=0 は受け付ける（実質無効化）", () => {
    expect(
      assetRetryConfigFromEnv({ PROXY_ASSET_RETRY_ATTEMPTS: "0" }).attempts
    ).toBe(0);
  });

  test("attempts の負数・非整数・空は既定 1", () => {
    expect(
      assetRetryConfigFromEnv({ PROXY_ASSET_RETRY_ATTEMPTS: "-1" }).attempts
    ).toBe(1);
    expect(
      assetRetryConfigFromEnv({ PROXY_ASSET_RETRY_ATTEMPTS: "1.5" }).attempts
    ).toBe(1);
    expect(
      assetRetryConfigFromEnv({ PROXY_ASSET_RETRY_ATTEMPTS: "x" }).attempts
    ).toBe(1);
    expect(
      assetRetryConfigFromEnv({ PROXY_ASSET_RETRY_ATTEMPTS: "" }).attempts
    ).toBe(1);
  });

  test("maxWaitMs の 0・負数・非整数は既定 2000", () => {
    expect(
      assetRetryConfigFromEnv({ PROXY_ASSET_RETRY_MAX_WAIT_MS: "0" }).maxWaitMs
    ).toBe(2000);
    expect(
      assetRetryConfigFromEnv({ PROXY_ASSET_RETRY_MAX_WAIT_MS: "-3" }).maxWaitMs
    ).toBe(2000);
    expect(
      assetRetryConfigFromEnv({ PROXY_ASSET_RETRY_MAX_WAIT_MS: "1e3" })
        .maxWaitMs
    ).toBe(2000);
  });
});

describe("computeRetryWaitMs", () => {
  const cfg = { attempts: 1, maxWaitMs: 2000 };

  test("Retry-After: 1（秒）→ 1000ms で再試行", () => {
    expect(computeRetryWaitMs("1", NOW, cfg)).toBe(1000);
  });

  test("Retry-After 欠落 → 短い既定待機（上限未満に丸め）", () => {
    expect(computeRetryWaitMs(null, NOW, cfg)).toBe(
      Math.min(DEFAULT_RETRY_WAIT_MS, cfg.maxWaitMs)
    );
  });

  test("Retry-After 欠落かつ maxWaitMs が既定待機より小さい → maxWaitMs に丸める", () => {
    expect(computeRetryWaitMs(null, NOW, { attempts: 1, maxWaitMs: 500 })).toBe(
      500
    );
  });

  test("Retry-After が上限超 → null（再試行しない＝即透過）", () => {
    // 3 秒 > 2000ms 上限
    expect(computeRetryWaitMs("3", NOW, cfg)).toBeNull();
  });

  test("Retry-After が上限ちょうど → 再試行する", () => {
    expect(computeRetryWaitMs("2", NOW, cfg)).toBe(2000);
  });

  test("Retry-After: 0（過去日時含む）→ 0ms で即時再試行", () => {
    expect(computeRetryWaitMs("0", NOW, cfg)).toBe(0);
    const past = new Date(NOW - 5000).toUTCString();
    expect(computeRetryWaitMs(past, NOW, cfg)).toBe(0);
  });
});
