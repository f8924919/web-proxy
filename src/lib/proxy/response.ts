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

// 相対パスの Location を持つリダイレクト応答を返す。
// Response.redirect(new URL(..., req.url)) のように req.url から絶対 URL を組むと、
// リバースプロキシ / ポート転送（code-server 等）越しで内部オリジン（localhost）が
// Location に漏れ、ブラウザが公開オリジンを離れて localhost へ遷移してしまう。
// 相対 Location はブラウザが公開オリジン基準で解決するため漏えいを防げる。
// 仕様: docs/spec/features/proxy.md §url 未指定時のホームリダイレクト
export function relativeRedirect(location: string, status = 307): Response {
  return new Response(null, { status, headers: { Location: location } });
}
