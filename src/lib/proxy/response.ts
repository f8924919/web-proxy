// ボディを持てない HTTP ステータス（WHATWG Fetch の nullBodyStatus）。
// これらでボディ付きの Response を構築すると例外（→ 500 クラッシュ）になるため、
// 中継時はボディ読取りをスキップしボディ null で返す。
// 注: 101 は <200 のため Response(null, { status: 101 }) でも例外になる
//     （Response のステータスは 200-599 のみ）。1xx は最終応答として中継できず、
//     呼び出し側の try-catch により 502 にフォールバックする。実運用で fetch が
//     1xx を最終応答として返すことはほぼ無い。
// 仕様: docs/spec/features/proxy.md §ステータスコードの中継
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

export function isNullBodyStatus(status: number): boolean {
  return NULL_BODY_STATUSES.has(status);
}
