// 仕様: docs/spec/features/proxy.md §クライアント IP の特定
//
// レート制限のバケットキーに使うクライアント IP を、リバースプロキシ / CDN 配下でも
// 実クライアントを識別できるよう次の優先順で解決する。
//   cf-connecting-ip → x-forwarded-for（先頭の値）→ x-real-ip → "unknown"

export function getClientIp(headers: Headers): string {
  const cfIp = headers.get("cf-connecting-ip")?.trim();
  if (cfIp) return cfIp;

  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (forwarded) return forwarded;

  const realIp = headers.get("x-real-ip")?.trim();
  if (realIp) return realIp;

  return "unknown";
}
