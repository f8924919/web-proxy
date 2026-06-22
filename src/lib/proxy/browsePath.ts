// ナビゲーション（ブラウズ）URL スキーム（パス反映）の組み立て・復元。
// ページ遷移 URL は、ターゲットの scheme / host / path をクエリではなく URL パスへ
// そのまま反映する（/browse/<scheme>/<host>/<path>）。これにより閲覧ページの location が
// ターゲットそのものを反映し、ターゲット SPA が location.search を読んで再構築するリンクが
// proxy 専用パラメータ（url=）で汚染されない（#115）。アセット中継の proxyPath.ts と同形。
// 仕様: docs/spec/features/proxy.md §ページ遷移のパス反映（#115）

const MARKER = "/browse/";

// 絶対 URL を /browse/<scheme>/<host>/<path><?query><#hash> 形式に組み立てる。
// host はポート込み。ターゲットの query は中継 URL の query としてそのまま載せる。
export function buildBrowsePath(absoluteUrl: string, basePath: string): string {
  const u = new URL(absoluteUrl);
  const scheme = u.protocol.replace(/:$/, "");
  // u.pathname はパス無し URL でも "/" を返すため、常に host 直後へ "/" が入る。
  return `${basePath}${MARKER}${scheme}/${u.host}${u.pathname}${u.search}${u.hash}`;
}

// /browse/<scheme>/<host>/<path> 形式の pathname（と search）からターゲット絶対 URL を
// 復元する。復元不能（マーカー無し・host 欠落・非対応スキーム・不正 URL）は null。
// percent-encoding を保つため、デコード済みの catch-all params ではなく生の pathname を渡すこと。
export function targetFromBrowsePath(
  pathname: string,
  search: string
): string | null {
  const i = pathname.indexOf(MARKER);
  if (i === -1) return null;
  const rest = pathname.slice(i + MARKER.length); // "https/host/path..."

  const firstSlash = rest.indexOf("/");
  if (firstSlash === -1) return null;
  const scheme = rest.slice(0, firstSlash);
  if (scheme !== "http" && scheme !== "https") return null;

  const afterScheme = rest.slice(firstSlash + 1); // "host/path..." or "host"
  const hostSlash = afterScheme.indexOf("/");
  const host = hostSlash === -1 ? afterScheme : afterScheme.slice(0, hostSlash);
  if (!host) return null;
  const path = hostSlash === -1 ? "" : afterScheme.slice(hostSlash); // "/path..."

  try {
    return new URL(`${scheme}://${host}${path}${search}`).href;
  } catch {
    return null;
  }
}
