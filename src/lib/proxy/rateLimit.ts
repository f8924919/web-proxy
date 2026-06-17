export class RateLimitExceededError extends Error {
  constructor() {
    super("Rate limit exceeded");
    this.name = "RateLimitExceededError";
  }
}

const WINDOW_MS = 60_000;
const MAX_REQUESTS = 60;

export class RateLimiter {
  private store = new Map<string, number[]>();

  check(ip: string): void {
    const now = Date.now();
    const cutoff = now - WINDOW_MS;
    const timestamps = (this.store.get(ip) ?? []).filter((t) => t > cutoff);

    if (timestamps.length >= MAX_REQUESTS) {
      throw new RateLimitExceededError();
    }

    timestamps.push(now);
    this.store.set(ip, timestamps);
  }
}

export const rateLimiter = new RateLimiter();
