export class RateLimitExceededError extends Error {
  constructor() {
    super("Rate limit exceeded");
    this.name = "RateLimitExceededError";
  }
}

const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_MAX_REQUESTS = 60;

export class RateLimiter {
  private store = new Map<string, number[]>();

  constructor(
    private readonly maxRequests: number = DEFAULT_MAX_REQUESTS,
    private readonly windowMs: number = DEFAULT_WINDOW_MS
  ) {}

  check(ip: string): void {
    const now = Date.now();
    const cutoff = now - this.windowMs;
    const timestamps = (this.store.get(ip) ?? []).filter((t) => t > cutoff);

    if (timestamps.length >= this.maxRequests) {
      throw new RateLimitExceededError();
    }

    timestamps.push(now);
    this.store.set(ip, timestamps);
  }
}

// ページ遷移（/browse）とアセット中継（/api/proxy）は別バケット・別上限で制限する。
// 1 枚の JS 重サイトはアセットを多数中継するため、アセット側の上限を大きく取る。
// 根拠: docs/spec/features/proxy.md §レート制限
export const pageRateLimiter = new RateLimiter(60);
export const assetRateLimiter = new RateLimiter(600);
