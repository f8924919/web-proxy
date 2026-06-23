// 仕様: docs/spec/features/proxy.md §クライアント IP の特定（信頼ヘッダーの明示設定・#132）
//
// レート制限・ナビゲーションループ検出のバケットキーに使うクライアント IP を解決する。
// cf-connecting-ip / x-forwarded-for / x-real-ip はクライアントが任意に詐称でき、無条件に
// 信頼するとヘッダーをリクエストごとに変えるだけで全ガードを回避できる（CWE-348）。そのため
// 「信頼するヘッダー」を env で明示設定したときのみ採用し、未設定なら詐称ヘッダーを一切信頼
// せず単一のグローバルバケット（"unknown"）にフォールバックする（fail-safe）。

// 信頼するヘッダー未設定・値欠落時に用いる fail-safe な単一バケットキー。
const GLOBAL_BUCKET = "unknown";

export interface ClientIpConfig {
  // 信頼して採用するクライアント IP ヘッダー名（小文字）。null なら転送ヘッダーを信頼しない。
  trustedHeader: string | null;
}

// env から信頼ヘッダー設定を読む純粋関数（browserFetch.ts の *FromEnv パターンに倣う）。
// PROXY_TRUSTED_IP_HEADER に前段の信頼プロキシが必ず上書きするヘッダー名を 1 つ設定する。
// 未設定・空はヘッダー不信用（null）。ヘッダー名はケース非依存のため小文字化して保持する。
export function clientIpConfigFromEnv(
  env: Record<string, string | undefined> = process.env
): ClientIpConfig {
  const header = env.PROXY_TRUSTED_IP_HEADER?.trim().toLowerCase();
  return { trustedHeader: header ? header : null };
}

// レート制限のバケットキーに使うクライアント IP を解決する純粋関数。信頼ヘッダーが設定
// されていればその値を採用し、未設定・値欠落なら GLOBAL_BUCKET を返す。呼び出し側は既定
// 引数で env を解決するため getClientIp(req.headers) のまま利用できる。
export function getClientIp(
  headers: Headers,
  config: ClientIpConfig = clientIpConfigFromEnv()
): string {
  const { trustedHeader } = config;
  if (!trustedHeader) return GLOBAL_BUCKET;

  const raw = headers.get(trustedHeader)?.trim();
  if (!raw) return GLOBAL_BUCKET;

  // X-Forwarded-For は "client, proxy1, proxy2, …" と左→右に積まれ、最左はクライアントが
  // 詐称可能。信頼プロキシが付与する最右の値を採用する（単一信頼プロキシ構成の実クライアント）。
  if (trustedHeader === "x-forwarded-for") {
    const parts = raw
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);
    return parts[parts.length - 1] ?? GLOBAL_BUCKET;
  }
  return raw;
}
