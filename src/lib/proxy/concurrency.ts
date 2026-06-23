// 同時接続数の制限（オープンプロキシ乱用対策・#133）。
// インメモリで「同時に処理中の中継数」をグローバル・IP 単位で制限する。レート制限（件数/分）と
// 直交し、短時間の大量同時接続による資源枯渇・踏み台化を、件数制限が効く前のバーストで抑止する。
// 仕様: docs/spec/features/proxy.md §同時接続数の制限（#133）

export type ConcurrencyScope = "global" | "ip";

// 同時処理数の上限超過。scope で「グローバル飽和（503）」「IP 単位の過剰並列（429）」を区別する。
export class ConcurrencyLimitExceededError extends Error {
  constructor(readonly scope: ConcurrencyScope) {
    super(`Concurrency limit exceeded (${scope})`);
    this.name = "ConcurrencyLimitExceededError";
  }
}

export class ConcurrencyLimiter {
  private global = 0;
  private perIp = new Map<string, number>();

  constructor(
    private readonly maxGlobal: number,
    private readonly maxPerIp: number
  ) {}

  // スロットを 1 つ確保し、冪等な解放関数を返す。上限超過時は確保せず例外を投げる。
  // グローバルを先に判定し（サーバー飽和を優先）、次に IP 単位を判定する。
  acquire(ip: string): () => void {
    if (this.global >= this.maxGlobal) {
      throw new ConcurrencyLimitExceededError("global");
    }
    const cur = this.perIp.get(ip) ?? 0;
    if (cur >= this.maxPerIp) {
      throw new ConcurrencyLimitExceededError("ip");
    }
    this.global++;
    this.perIp.set(ip, cur + 1);

    // 解放関数は冪等（finally での二重解放に耐える）。複数回呼んでも 1 回だけ減算する。
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.global--;
      const next = (this.perIp.get(ip) ?? 1) - 1;
      if (next <= 0) this.perIp.delete(ip);
      else this.perIp.set(ip, next);
    };
  }

  // テスト用: 現在のグローバル同時数。
  get active(): number {
    return this.global;
  }

  // テスト用: 同時処理中の IP エントリ数（0 になったエントリは削除済み）。
  get size(): number {
    return this.perIp.size;
  }
}

const DEFAULT_MAX_GLOBAL = 512;
const DEFAULT_MAX_PER_IP = 64;

export interface ConcurrencyConfig {
  maxGlobal: number;
  maxPerIp: number;
}

function positiveIntFromEnv(raw: string | undefined, fallback: number): number {
  const t = raw?.trim();
  if (!t) return fallback;
  const n = Number(t);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

// env から同時接続上限を読む純粋関数。PROXY_MAX_CONCURRENT（既定 512）/
// PROXY_MAX_CONCURRENT_PER_IP（既定 64）。正の整数以外・未設定は既定値（maxBufferBytesFromEnv 同様）。
export function concurrencyConfigFromEnv(
  env: Record<string, string | undefined> = process.env
): ConcurrencyConfig {
  return {
    maxGlobal: positiveIntFromEnv(env.PROXY_MAX_CONCURRENT, DEFAULT_MAX_GLOBAL),
    maxPerIp: positiveIntFromEnv(
      env.PROXY_MAX_CONCURRENT_PER_IP,
      DEFAULT_MAX_PER_IP
    ),
  };
}

// 中継本体（relayAsset / relayBrowse）が共有するシングルトン。モジュール読込時に env から
// 上限を解決する。中継の入口で acquire し、レスポンス構築後の finally で解放する。
const config = concurrencyConfigFromEnv();
export const relayConcurrencyLimiter = new ConcurrencyLimiter(
  config.maxGlobal,
  config.maxPerIp
);
