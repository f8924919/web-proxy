// 中継処理の異常系ログを集約する横断ユーティリティ。
// 閲覧先 URL・ホスト・IP は機微情報になり得る（OWASP A09:2021 / CWE-532）ため、
// 出力前に機微トークンを redact し、PROXY_LOG_LEVEL でレベル制御する。
// 仕様: docs/spec/features/proxy.md §エラーログとプライバシー（#138）
// 実装意図: docs/arch/proxy.md §src/lib/logger.ts（共通ロガー・#138）

export type LogLevel = "silent" | "error" | "warn" | "info" | "debug";

// レベルの強さ（大きいほど詳細）。出力可否は「設定レベル >= 要求レベル」で判定する。
const LEVEL_ORDER: Record<LogLevel, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

// PROXY_LOG_LEVEL を読み、既知のレベルへ正規化する純粋関数（*FromEnv パターン）。
// 未設定・未知値・空文字は既定 "error" にフォールバックする。
export function logLevelFromEnv(
  env: Partial<NodeJS.ProcessEnv> = process.env
): LogLevel {
  const raw = env.PROXY_LOG_LEVEL?.trim().toLowerCase();
  if (raw && raw in LEVEL_ORDER) return raw as LogLevel;
  return "error";
}

// 任意文字列から機微トークン（URL・IP・素のホスト名）を伏せる純粋関数。
// 閲覧先ホスト自体が機微なため origin・パスを残さず全面 redact する。
// 安全側に倒すため、非機微トークンを過剰一致でマスクし得る点は許容する（#138）。
export function maskSensitive(text: string): string {
  return (
    text
      // scheme://… 形式の URL（最優先。ホスト＋パス＋クエリをまとめて伏せる）
      .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "[redacted-url]")
      // IPv4
      .replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, "[redacted-ip]")
      // IPv6（:: 圧縮形・先頭 :: のループバック含む。コロン 2 個以上を含む塊を伏せる。
      // 先頭/末尾が : のため \b では境界が立たず、語/コロン以外の前後で区切る）
      .replace(
        /(?<![\w:])[0-9a-f]{0,4}(?::[0-9a-f]{0,4}){2,}(?![\w:])/gi,
        "[redacted-ip]"
      )
      // 素のホスト名 / ドメイン（例: ENOTFOUND sub.example.com）
      .replace(/\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b/gi, "[redacted-host]")
  );
}

// トップ例外に続けて展開する cause の最大段数（トップ自身は含まない）。
// 上流 fetch の失敗は FetchTimeoutError → TypeError: fetch failed → ランタイム側の
// 実エラー、と多段になるため 1 段では根本原因に届かない（#236）。循環参照でも停止する。
const MAX_CAUSE_DEPTH = 5;

// Error を「name: redact 済み message」へ整形する。
// name（エラークラス名）は運用診断に必要かつ機微でないため残す。
// message・cause（ネイティブ fetch 失敗は cause にホストを含む）は redact する。
// includeStack 時のみ redact 付きでスタックを添える。
export function formatError(err: unknown, includeStack = false): string {
  if (err instanceof Error) {
    let out = `${err.name}: ${maskSensitive(err.message)}`;
    let cause = (err as Error & { cause?: unknown }).cause;
    for (let depth = 0; depth < MAX_CAUSE_DEPTH && cause != null; depth++) {
      if (cause instanceof Error) {
        out += ` (caused by ${cause.name}: ${maskSensitive(cause.message)})`;
        cause = (cause as Error & { cause?: unknown }).cause;
      } else {
        out += ` (caused by ${maskSensitive(String(cause))})`;
        break;
      }
    }
    if (includeStack && err.stack) {
      out += `\n${maskSensitive(err.stack)}`;
    }
    return out;
  }
  return maskSensitive(String(err));
}

// 中継処理の異常系を出力する共通エントリ。設定レベルが error 以上のときだけ出力し、
// silent では何も出さない。スタックは debug 時のみ添える。
export function logError(label: string, err: unknown): void {
  const level = logLevelFromEnv();
  if (LEVEL_ORDER[level] < LEVEL_ORDER.error) return;
  console.error(label, formatError(err, level === "debug"));
}
