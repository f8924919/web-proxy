// アセット中継が上流から受けた 429 を Retry-After 尊重でサーバー側リトライするための、
// 純粋ロジックと待機ユーティリティ（#166）。relayAsset 本体は現行方針でテスト対象外のため、
// 判定・待機計算を純粋関数へ切り出して単体テスト可能にする。
// 仕様: docs/spec/features/proxy.md §アセット中継の上流 429 リトライ（Retry-After 尊重・#166）
//      docs/arch/proxy.md §retry.ts（上流 429 リトライ・#166）

// Retry-After 欠落・解析不能時の短い既定待機（ms）。computeRetryWaitMs で maxWaitMs 未満に丸める。
export const DEFAULT_RETRY_WAIT_MS = 1000;

const DEFAULT_ATTEMPTS = 1;
const DEFAULT_MAX_WAIT_MS = 2000;

export interface AssetRetryConfig {
  // 上流 429 に対する最大再試行回数（0 で実質無効化）。
  attempts: number;
  // サーバー側で待たせる上限（ms）。Retry-After がこれを超える場合は再試行しない。
  maxWaitMs: number;
}

// Retry-After ヘッダー文字列を待機ミリ秒へ解釈する純粋関数。
// - 非負整数の秒数（"1" 等）→ 秒 × 1000。
// - HTTP-date（"Wed, 21 Oct 2026 07:28:00 GMT" 等）→ nowMs との差（過去は 0）。
// - 欠落（null）・空・解析不能・負値・非整数の秒数 → null（呼び出し側で既定待機へ）。
export function parseRetryAfter(
  value: string | null,
  nowMs: number
): number | null {
  if (value === null) return null;
  const t = value.trim();
  if (!t) return null;

  // 数値らしき入力は delta-seconds として扱う。非負整数のみ有効、負値・小数は不正値（null）。
  // （Date.parse へ落とすと "-5" 等が環境依存で誤解釈されうるため、ここで確定させる。）
  if (/^-?\d*\.?\d+$/.test(t)) {
    if (/^\d+$/.test(t)) return Number(t) * 1000;
    return null;
  }

  const parsed = Date.parse(t);
  if (Number.isNaN(parsed)) return null;
  return Math.max(0, parsed - nowMs);
}

// env から再試行設定を読む純粋関数。PROXY_ASSET_RETRY_ATTEMPTS（既定 1・0 以上の整数）/
// PROXY_ASSET_RETRY_MAX_WAIT_MS（既定 2000・正の整数）。不正値・未設定は既定へフォールバック
// （maxBufferBytesFromEnv と同方針。ただし指数表記等を避けるため厳密な数字列のみ受理する）。
export function assetRetryConfigFromEnv(
  env: Record<string, string | undefined> = process.env
): AssetRetryConfig {
  return {
    attempts: intFromEnv(
      env.PROXY_ASSET_RETRY_ATTEMPTS,
      DEFAULT_ATTEMPTS,
      true
    ),
    maxWaitMs: intFromEnv(
      env.PROXY_ASSET_RETRY_MAX_WAIT_MS,
      DEFAULT_MAX_WAIT_MS,
      false
    ),
  };
}

function intFromEnv(
  raw: string | undefined,
  fallback: number,
  allowZero: boolean
): number {
  const t = raw?.trim();
  if (!t || !/^\d+$/.test(t)) return fallback;
  const n = Number(t);
  if (!Number.isInteger(n)) return fallback;
  if (n === 0) return allowZero ? 0 : fallback;
  return n;
}

// リトライ可否と待機 ms を一手に決める純粋関数。relayAsset のループはこの戻り値だけで分岐する。
// - Retry-After 欠落・解析不能 → 短い既定待機（min(DEFAULT_RETRY_WAIT_MS, maxWaitMs)）。
// - 解析値が maxWaitMs 超 → null（再試行しない＝429 を即透過）。
// - それ以外 → 解析値（過去日時は 0）。
export function computeRetryWaitMs(
  retryAfterHeader: string | null,
  nowMs: number,
  config: AssetRetryConfig
): number | null {
  const parsed = parseRetryAfter(retryAfterHeader, nowMs);
  if (parsed === null) return Math.min(DEFAULT_RETRY_WAIT_MS, config.maxWaitMs);
  if (parsed > config.maxWaitMs) return null;
  return parsed;
}

// setTimeout ベースの待機。I/O 相当のため純粋関数テストの対象外（relayAsset の配線でのみ使用）。
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
