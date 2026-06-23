// 中継対象スキーム・ポートの制限（オープンプロキシ乱用対策・#133）。
// 中継先 URL のスキーム（http/https）とポート（既定 80/443・env で追加可）を許可リスト方式で
// 検証する純粋関数群。中継本体（relayAsset / browseGuards）が上流取得の前に呼ぶ。
// 仕様: docs/spec/features/proxy.md §中継対象スキーム・ポートの制限（#133）

// 既定で許可する中継先ポート（http=80 / https=443 の標準ポート）。
export const DEFAULT_ALLOWED_PORTS: readonly number[] = [80, 443];

// env から許可ポート集合を読む純粋関数。PROXY_ALLOWED_PORTS はカンマ区切りのポート番号
// （例 "8080,8443"）。既定の 80/443 に「追加」し、1〜65535 の整数以外は無視する。
// 既定の 80/443 は常に含まれ env で外せない（fail-safe）。
export function allowedPortsFromEnv(
  env: Record<string, string | undefined> = process.env
): Set<number> {
  const ports = new Set<number>(DEFAULT_ALLOWED_PORTS);
  const raw = env.PROXY_ALLOWED_PORTS?.trim();
  if (!raw) return ports;
  for (const part of raw.split(",")) {
    const n = Number(part.trim());
    if (Number.isInteger(n) && n >= 1 && n <= 65535) ports.add(n);
  }
  return ports;
}

// 中継先 URL のスキーム・ポートが許可されているか判定する純粋関数。
// スキームは http/https のみ。ポート明示なしの URL はスキーム既定（http=80 / https=443）を
// 補って判定する。許可外は中継せず、呼び出し側が 403 を返す。
export function isAllowedTarget(
  parsed: URL,
  allowedPorts: Set<number>
): boolean {
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  const port = parsed.port
    ? Number(parsed.port)
    : parsed.protocol === "https:"
      ? 443
      : 80;
  return allowedPorts.has(port);
}
