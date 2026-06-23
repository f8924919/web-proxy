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
  // 前回 eviction を実行した時刻。毎リクエストの全走査を避け windowMs ごとに間引く。
  private lastEviction = 0;

  constructor(
    private readonly maxRequests: number = DEFAULT_MAX_REQUESTS,
    private readonly windowMs: number = DEFAULT_WINDOW_MS
  ) {}

  check(ip: string): void {
    const now = Date.now();
    const cutoff = now - this.windowMs;
    this.evictExpired(cutoff, now);

    const timestamps = (this.store.get(ip) ?? []).filter((t) => t > cutoff);

    if (timestamps.length >= this.maxRequests) {
      throw new RateLimitExceededError();
    }

    timestamps.push(now);
    this.store.set(ip, timestamps);
  }

  // 全タイムスタンプがウィンドウ外になった空エントリを削除し、偽装 IP 等での store 肥大を
  // 防ぐ（#132）。前回 eviction から windowMs 未満なら走査を省く。
  private evictExpired(cutoff: number, now: number): void {
    if (now - this.lastEviction < this.windowMs) return;
    this.lastEviction = now;
    for (const [key, timestamps] of this.store) {
      if (timestamps.every((t) => t <= cutoff)) this.store.delete(key);
    }
  }

  // テスト用: 現在のエントリ数。
  get size(): number {
    return this.store.size;
  }
}

// ページ遷移（/browse）とアセット中継（/api/proxy）は別バケット・別上限で制限する。
// 1 枚の JS 重サイトはアセットを多数中継するため、アセット側の上限を大きく取る。
// 根拠: docs/spec/features/proxy.md §レート制限
export const pageRateLimiter = new RateLimiter(60);
export const assetRateLimiter = new RateLimiter(600);
