import { parse } from "node-html-parser";
import { buildProxyPath } from "./proxyPath";
import { buildBrowsePath } from "./browsePath";

const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

function resolve(href: string, base: string): string {
  try {
    return new URL(href, base).href;
  } catch {
    return href;
  }
}

function browseUrl(href: string, base: string): string {
  const resolved = resolve(href, base);
  if (!resolved.startsWith("http://") && !resolved.startsWith("https://")) {
    return resolved;
  }
  // パス反映ナビ形式（/browse/<scheme>/<host>/<path>）。閲覧ページの location が
  // ターゲットを反映し、SPA が location を読んで再構築するリンクが proxy 専用
  // パラメータ（url=）で汚染されないようにする（#115）。
  // 仕様: docs/spec/features/proxy.md §ページ遷移のパス反映
  return buildBrowsePath(resolved, BASE_PATH);
}

// <meta http-equiv="refresh"> の content（"<遅延>;url=<TARGET>"）内の url を
// browseUrl() で書き換える。url が無い純粋な遅延 refresh はそのまま返す。
// url= の前後空白・大文字小文字・クォート（' / "）を許容し、遅延部は保持する。
// 仕様: docs/spec/features/proxy.md §meta refresh の書き換え
export function rewriteMetaRefreshContent(
  content: string,
  base: string
): string {
  return content.replace(
    /(url\s*=\s*)(['"]?)([^'"]*)\2/i,
    (whole, prefix: string, quote: string, target: string) => {
      const trimmed = target.trim();
      if (!trimmed) return whole;
      const rewritten = browseUrl(trimmed, base);
      // browseUrl は http(s) に解決できない URL は素通しする。素通し時は無変更。
      if (rewritten === trimmed) return whole;
      return `${prefix}${quote}${rewritten}${quote}`;
    }
  );
}

function assetUrl(href: string, base: string): string {
  const resolved = resolve(href, base);
  if (!resolved.startsWith("http://") && !resolved.startsWith("https://")) {
    return resolved;
  }
  // パス反映形式（/api/proxy/<scheme>/<host>/<path>）。ランタイム相対 import が
  // ブラウザ上で正しく解決されるようにする（#100）。
  // 仕様: docs/spec/features/proxy.md §プロキシ URL スキーム（パス反映）
  return buildProxyPath(resolved, BASE_PATH);
}

// srcset 属性（`url [記述子]` のカンマ区切りリスト）の各候補の URL 部のみを
// assetUrl() で書き換え、記述子（1x / 2x / 640w 等）はそのまま保持して再結合する。
// WHATWG の srcset 解析に準じ、URL 部は空白以外の連続文字として取り出すため、
// data: URL 内のカンマでも誤分割しない。src だけ書き換えて srcset を放置すると
// ブラウザが srcset 側の未書き換え候補を採用してしまう（Next.js <Image> の
// /_next/image?url=… がプロキシ origin 直下へ解決され 400 になる等。#98）。
// 仕様: docs/spec/features/proxy.md §srcset の書き換え
export function rewriteSrcset(value: string, base: string): string {
  const isWs = (c: string) =>
    c === " " || c === "\t" || c === "\n" || c === "\f" || c === "\r";
  const candidates: string[] = [];
  let pos = 0;
  const len = value.length;
  while (pos < len) {
    // 先頭の空白・カンマ（候補区切り）を読み飛ばす。
    while (pos < len && (isWs(value[pos]) || value[pos] === ",")) pos++;
    if (pos >= len) break;
    // URL 部: 空白以外の連続文字。
    const urlStart = pos;
    while (pos < len && !isWs(value[pos])) pos++;
    let url = value.slice(urlStart, pos);
    let descriptor = "";
    if (url.endsWith(",")) {
      // 末尾カンマは「記述子なし」の候補区切り。URL から外す。
      url = url.replace(/,+$/, "");
    } else {
      // URL 直後の空白を読み飛ばし、次のカンマまでを記述子として保持する。
      while (pos < len && isWs(value[pos])) pos++;
      const descStart = pos;
      while (pos < len && value[pos] !== ",") pos++;
      descriptor = value.slice(descStart, pos).trim();
      if (pos < len) pos++; // 候補区切りのカンマを消費する。
    }
    const rewritten = assetUrl(url, base);
    candidates.push(descriptor ? `${rewritten} ${descriptor}` : rewritten);
  }
  return candidates.join(", ");
}

// アドレスバーはビューポート上部へ常に固定する（position: fixed）。
// position: sticky はターゲットが `html, body { height:100% }` を指定すると包含ブロックが
// 1 ビューポート分に制限され、スクロールでバーが画面外へ消える（#108。ipleak.net 等）。
// fixed はコンテンツに重なるため、直後のスペーサー（#proxy-addressbar-spacer）の高さを
// バーの実レンダリング高へ同期し（初期 + resize / load）、重なりを防ぐ。
// 仕様: docs/spec/screens/browse.md §コンテンツエリア / docs/arch/proxy.md §アドレスバー注入
// HTML テキスト/属性値コンテキストへ動的文字列を埋め込む際の出力エスケープ。
// & < > " ' を一括して実体参照へ変換する（& を最先頭に処理し二重実体化を防ぐ）。
// 仕様: docs/spec/screens/browse.md §アドレスバー / docs/arch/proxy.md §アドレスバー注入（#137・CWE-116）
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const ADDRESS_BAR_HTML = (currentUrl: string) =>
  `
<div id="proxy-addressbar" style="position:fixed;top:0;left:0;right:0;z-index:99999;background:#1e1e2e;padding:6px 12px;display:flex;gap:8px;align-items:center;font-family:sans-serif;box-shadow:0 2px 4px rgba(0,0,0,.4)">
  <form onsubmit="(function(e){e.preventDefault();var v=e.target.querySelector('input').value;if(!v)return;window.location.href='${BASE_PATH}/browse?url='+encodeURIComponent(v.startsWith('http')?v:'https://'+v)})(event)" style="display:flex;flex:1;gap:8px">
    <input value="${escapeHtml(currentUrl)}" style="flex:1;padding:4px 10px;border:1px solid #555;border-radius:4px;background:#2a2a3e;color:#fff;font-size:14px" />
    <button type="submit" style="padding:4px 14px;background:#0070f3;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:14px">移動</button>
  </form>
  <a href="${BASE_PATH}/" style="color:#aaa;font-size:13px;text-decoration:none">ホーム</a>
</div>
<div id="proxy-addressbar-spacer" style="height:44px"></div>
<script>(function(){var b=document.getElementById('proxy-addressbar'),s=document.getElementById('proxy-addressbar-spacer');if(!b||!s)return;function f(){s.style.height=b.offsetHeight+'px';}f();addEventListener('resize',f);addEventListener('load',f);})();</script>`.trim();

// url 未指定の GET /browse 用の案内ページ HTML（HTTP 200・自動遷移なし）。
// 以前はホーム（${BASE_PATH}/）へ 307 リダイレクトしていたが、リバースプロキシ
// （code-server のポート転送 /proxy/3000）配下では戻り先が末尾スラッシュ正規化で
// 404 になっていた。リダイレクトせず、アドレスバー（フォームは ${BASE_PATH}/browse?url=
// へ遷移＝正しく解決される経路）を含む 200 ページをその場で返して 404 を解消する。
// アドレスバー HTML は ADDRESS_BAR_HTML を再利用し重複させない。
// 仕様: docs/spec/features/proxy.md §url 未指定時の案内ページ（GET）（#74）
export function noUrlBrowseHtml(): string {
  return `<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>URL を入力</title></head><body style="margin:0;background:#f5f5f5">
${ADDRESS_BAR_HTML("")}
<div style="padding:2rem;font-family:sans-serif;color:#333">
<p>閲覧する URL が指定されていません。上のアドレスバーに URL を入力して「移動」を押してください。</p>
</div>
</body></html>`;
}

// 注入スクリプトにも埋め込む小さな純関数群（外部参照を持たず URL のみで完結）。
// クリック横取り・GET フォーム横取りの両方が、パス反映ナビ形式（/browse/<scheme>/<host>/<path>・
// #115）と後方互換（…/browse?url=）の両方から「現ターゲット」「振り向け先プレフィックス」を
// 一貫して導出するために共有する。

// 閲覧ページ／action URL から、パス反映ナビのプレフィックス（BASE_PATH 込みの …/browse/）を返す。
// パス反映: …/browse/ マーカーまで。後方互換: 末尾が /browse なら + "/"。導出不能なら null。
export function browseNavPrefix(pageUrl: string): string | null {
  let p: URL;
  try {
    p = new URL(pageUrl);
  } catch {
    return null;
  }
  const MARKER = "/browse/";
  const idx = p.pathname.indexOf(MARKER);
  if (idx !== -1) return p.pathname.slice(0, idx + MARKER.length);
  if (/\/browse$/.test(p.pathname)) return p.pathname + "/";
  return null;
}

// proxy ナビ URL（パス反映 …/browse/<scheme>/<host>/<path> または後方互換 …/browse?url=）から
// ターゲット絶対 URL を復元する。復元不能なら null。
export function extractBrowseTarget(browseUrl: string): string | null {
  let u: URL;
  try {
    u = new URL(browseUrl);
  } catch {
    return null;
  }
  const MARKER = "/browse/";
  const idx = u.pathname.indexOf(MARKER);
  if (idx !== -1) {
    const rest = u.pathname.slice(idx + MARKER.length);
    const fs = rest.indexOf("/");
    if (fs === -1) return null;
    const scheme = rest.slice(0, fs);
    if (scheme !== "http" && scheme !== "https") return null;
    const after = rest.slice(fs + 1);
    const hs = after.indexOf("/");
    const host = hs === -1 ? after : after.slice(0, hs);
    if (!host) return null;
    const path = hs === -1 ? "" : after.slice(hs);
    try {
      return new URL(scheme + "://" + host + path + u.search).href;
    } catch {
      return null;
    }
  }
  return u.searchParams.get("url");
}

// 絶対 URL を、与えたプレフィックス（…/browse/）配下のパス反映ナビ形式に組み立てる。
// percent-encoding を保持する（WHATWG URL の pathname/search をそのまま連結）。
export function buildBrowseDest(
  absoluteUrl: string,
  prefix: string
): string | null {
  let u: URL;
  try {
    u = new URL(absoluteUrl);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const scheme = u.protocol.replace(/:$/, "");
  return prefix + scheme + "/" + u.host + u.pathname + u.search + u.hash;
}

// GET フォーム送信の振り向け先を決定する純粋関数。
// パス反映ナビ形式（#115）ではターゲットがパス部に残り GET 送信でも失われないが、SPA の自前
// submit ハンドラによる後勝ち遷移（#93）を阻止するため横取りは維持する。ターゲットを復元し、
// そのクエリをフォーム項目で置き換えてパス反映ナビ形式 /browse/<scheme>/<host>/<path>?<再構築>
// を組み立てる。横取り不要（GET 以外・ターゲット復元不可）なら null を返す。
// 注入スクリプトはこの関数と上記ヘルパーを toString() で埋め込むため、外部参照を持たず
// URL / URLSearchParams（ブラウザ・Node 共通のグローバル）のみで完結させる。
// 仕様: docs/spec/features/proxy.md §GET フォーム送信の横取り
export function buildGetFormDestination(
  method: string,
  action: string,
  pageUrl: string,
  entries: [string, string][]
): string | null {
  if ((method || "get").toLowerCase() !== "get") return null;

  // action（書き換え済みナビ URL）を閲覧ページ URL で解決して読む。
  let browseRef: string;
  try {
    browseRef = new URL(action || pageUrl, pageUrl).href;
  } catch {
    return null;
  }

  let targetStr = extractBrowseTarget(browseRef);
  let prefix = browseNavPrefix(browseRef);
  if (!targetStr || !prefix) {
    // action が proxy ナビ URL でない場合の復元。
    //  (1) 閲覧ページ（プロキシ）と別オリジンの絶対 http(s) URL（React 等のハイドレーションで
    //      実サイト URL へ復元された action 等。#164）は、その URL 自体を実ターゲットとして
    //      直接 proxify する。プレフィックスは閲覧ページから導出する。
    //  (2) それ以外（同一オリジンのルート相対 action・action 無し等）は閲覧ページ自身から復元する。
    const pagePrefix = browseNavPrefix(pageUrl);
    let ref: URL | null = null;
    let pageOrigin: string | null = null;
    try {
      ref = new URL(browseRef);
      pageOrigin = new URL(pageUrl).origin;
    } catch {
      ref = null;
    }
    if (
      ref &&
      pagePrefix &&
      ref.origin !== pageOrigin &&
      (ref.protocol === "http:" || ref.protocol === "https:")
    ) {
      targetStr = ref.href;
      prefix = pagePrefix;
    } else {
      targetStr = extractBrowseTarget(pageUrl);
      prefix = pagePrefix;
    }
  }
  if (!targetStr || !prefix) return null;

  let target: URL;
  try {
    target = new URL(targetStr);
  } catch {
    return null;
  }

  // ターゲットのクエリ全体をフォーム項目で置き換える（GET 送信の本来の挙動を再現）。
  const params = new URLSearchParams();
  for (const [k, v] of entries) params.append(k, v);
  target.search = params.toString();

  return buildBrowseDest(target.href, prefix);
}

// GET フォーム送信を横取りする注入スクリプト。
// 純粋ロジック（buildGetFormDestination）を toString() で埋め込み、ブラウザでは
// 3 経路で捕捉する:
//  (A) document への submit イベント委任（capture）。動的フォーム・ネイティブ submit・
//      requestSubmit（submit イベントを発火する）を含めて捕捉する。横取り時は
//      preventDefault に加え stopImmediatePropagation を呼び、SPA（React 等）が
//      バブルの自前 submit ハンドラで実サイトへ後勝ち遷移するのを阻止する（#93。
//      クリック横取りと同方式）。
//  (B) HTMLFormElement.prototype.submit のオーバーライド。form.submit()（プログラム送信）は
//      submit イベントを発火しないため (A) で捕捉できない（例: Google 検索）。同じ
//      buildGetFormDestination を適用して振り向ける（#78）。
//  (C) document への keydown イベント委任（capture・Enter キー）。submit イベントも
//      form.submit() も介さず、自前の keydown ハンドラで location.href へ実サイト絶対 URL を
//      直接代入して遷移するサイト（例: www.yahoo.co.jp トップ検索）対策（#164）。location 系は
//      改変不能でフックできないため、Enter をサイトのハンドラより先に capture で奪い、フォーム内
//      input の暗黙送信相当のときだけ stopImmediatePropagation して同じ振り向けロジックで遷移する。
//      IME 変換中・修飾キー併用・textarea・送信を伴わない input 型・フォーム外 input は素通しする。
// 自前のアドレスバー（#proxy-addressbar 内のフォーム）は独自の onsubmit を持つため
// 全経路で横取り対象から除外する（横取りすると入力 URL が無視され得る）。
const GET_FORM_INTERCEPT_HTML =
  `<script>(function(){` +
  `var browseNavPrefix=${browseNavPrefix.toString()};` +
  `var extractBrowseTarget=${extractBrowseTarget.toString()};` +
  `var buildBrowseDest=${buildBrowseDest.toString()};` +
  `var build=${buildGetFormDestination.toString()};` +
  `document.addEventListener('submit',function(e){` +
  `var f=e.target;if(!f||f.tagName!=='FORM')return;` +
  `if(f.closest&&f.closest('#proxy-addressbar'))return;` +
  `var fd;try{fd=new FormData(f,e.submitter)}catch(_){fd=new FormData(f)}` +
  `var dest=build(f.getAttribute('method')||'get',f.getAttribute('action')||'',location.href,Array.from(fd.entries()));` +
  `if(dest){e.preventDefault();e.stopImmediatePropagation();location.href=dest;}` +
  `},true);` +
  // (C) Enter キー押下（submit/form.submit() を介さず location.href 直接代入で遷移するサイト対策。#164）。
  `document.addEventListener('keydown',function(e){` +
  `if(e.key!=='Enter'||e.isComposing||e.keyCode===229)return;` +
  `if(e.defaultPrevented||e.metaKey||e.ctrlKey||e.shiftKey||e.altKey)return;` +
  `var t=e.target;if(!t||t.tagName!=='INPUT')return;` +
  `var ty=(t.getAttribute('type')||'text').toLowerCase();` +
  `if(ty==='button'||ty==='submit'||ty==='reset'||ty==='checkbox'||ty==='radio'||ty==='file'||ty==='image')return;` +
  `var f=t.form||(t.closest&&t.closest('form'));if(!f)return;` +
  `if(f.closest&&f.closest('#proxy-addressbar'))return;` +
  `var fd;try{fd=new FormData(f)}catch(_){fd=null}` +
  `var dest=fd?build(f.getAttribute('method')||'get',f.getAttribute('action')||'',location.href,Array.from(fd.entries())):null;` +
  `if(dest){e.preventDefault();e.stopImmediatePropagation();location.href=dest;}` +
  `},true);` +
  // (B) form.submit()（プログラム送信）。submit イベントを出さないので prototype を上書きする。
  `var _s=HTMLFormElement.prototype.submit;` +
  `HTMLFormElement.prototype.submit=function(){` +
  `try{` +
  `if(!(this.closest&&this.closest('#proxy-addressbar'))){` +
  `var fd;try{fd=new FormData(this)}catch(_){fd=null}` +
  `var dest=fd?build(this.getAttribute('method')||'get',this.getAttribute('action')||'',location.href,Array.from(fd.entries())):null;` +
  `if(dest){location.href=dest;return;}` +
  `}` +
  `}catch(_){}` +
  `return _s.apply(this,arguments);` +
  `};` +
  `})()</script>`;

// クリックによるナビゲーションの振り向け先を決定する純粋関数。
// サーバー側 rewriteHtml の <a href> 書き換えは初期 HTML のみが対象で、(1) JS が動的描画した
// リンク（生の絶対/相対 URL）、(2) SPA ルーターが onClick で横取りする <a> クリックは、いずれも
// 実サイトへ離脱する。これを補い、クリック先をパス反映ナビ形式（/browse/<scheme>/<host>/<path>・
// #115）へ振り向ける。返り値は遷移先パス（BASE_PATH 込みのプレフィックスを再利用）、横取り
// しない場合は null。
//   - 外部オリジンの絶対 URL（プロトコル相対含む）→ 当該 URL をパス反映ナビ形式へ
//   - 既に書き換え済みの proxy ナビリンク（パス反映 …/browse/<scheme>/… or 後方互換 …/browse?url=）
//     → その path+search+hash をそのまま返す（SPA ルーターに奪われる前にフルナビゲーション）
//   - その他の同一オリジン（/articles/… ・クエリのみ相対 ?q=… 等）→ 現ターゲットを base に
//     解決し直してパス反映ナビ形式へ（#114）
//   - # 同一ページアンカー・非 http スキーム・ターゲット復元不可は null
// 注入スクリプトはこの関数と browseNavPrefix / extractBrowseTarget / buildBrowseDest を
// toString() で埋め込むため、外部参照を持たず URL のみで完結させる。
// 仕様: docs/spec/features/proxy.md §クライアント側ナビゲーションの横取り
export function buildClickNavDestination(
  href: string,
  pageUrl: string
): string | null {
  if (!href || href.charAt(0) === "#") return null;
  let page: URL;
  let dest: URL;
  try {
    page = new URL(pageUrl);
    // ブラウザが実際に遷移する先（href を閲覧ページ基準で解決）。
    dest = new URL(href, pageUrl);
  } catch {
    return null;
  }
  // http(s) 以外（javascript:/mailto:/tel:/data: 等）は素通し。
  if (dest.protocol !== "http:" && dest.protocol !== "https:") return null;

  if (dest.origin === page.origin) {
    // 既に書き換え済みの proxy ナビリンクはそのままフルナビゲーション。
    //  - パス反映形式: /browse/ マーカー直後が有効な scheme（http/https）の真の中継リンク。
    //    extractBrowseTarget が復元できること（non-null）で判定し、ターゲット自身の
    //    /browse/foo のようなルート相対リンク（復元不能＝400 になる）を誤って素通ししない。
    //    クエリのみ相対 ?q=… がパス反映ページでネイティブ解決され同形に着地したケースも含む。
    //  - 後方互換形式: 末尾が /browse かつ url= を持つ（#114。url= 無しの ?q=… は素通しせず
    //    下の target 基準解決へ流す）。
    const destIsReflect =
      dest.pathname.indexOf("/browse/") !== -1 &&
      extractBrowseTarget(dest.href) !== null;
    const destIsLegacy =
      /\/browse$/.test(dest.pathname) && dest.searchParams.has("url");
    if (destIsReflect || destIsLegacy) {
      return dest.pathname + dest.search + dest.hash;
    }
    // それ以外（/articles/… のルート相対・相対、クエリのみ相対 ?q=… 等）は、現ターゲットを
    // base に解決し直してパス反映ナビ形式へ振り向ける。
    const target = extractBrowseTarget(pageUrl);
    if (!target) return null;
    let real: URL;
    try {
      real = new URL(href, target);
    } catch {
      return null;
    }
    if (real.protocol !== "http:" && real.protocol !== "https:") return null;
    const prefix = browseNavPrefix(pageUrl);
    if (!prefix) return null;
    return buildBrowseDest(real.href, prefix);
  }
  // 外部オリジンの絶対 URL（プロトコル相対含む）。
  const prefix = browseNavPrefix(pageUrl);
  if (!prefix) return null;
  return buildBrowseDest(dest.href, prefix);
}

// 横取りしてはいけないプロキシ自前ルートか判定する（BASE_PATH を取り除いた上で判定）。
// public/sw.js の同名関数と対の規則（SW は importScripts 不可のためロジック共有できず、
// 両ファイルに同等実装を持つ。差分が出ないよう対で保守する）。
// 仕様: docs/spec/features/proxy.md §実行時リクエスト横取りシム（SW 非依存・#124）
export function isProxyOwnPath(pathname: string, basePath: string): boolean {
  let p = pathname;
  if (basePath && p.startsWith(basePath)) {
    p = p.slice(basePath.length) || "/";
  }
  if (p === "" || p === "/") return true; // ホーム
  if (p === "/sw.js") return true;
  if (p === "/unlock") return true; // 共有トークン認証の解錠ルート（#148）
  // 完全一致＋パス境界で判定（ターゲット側の /browser や /api/proxyData を誤判定しない）
  if (p === "/browse" || p.startsWith("/browse/")) return true;
  if (p === "/api/proxy" || p.startsWith("/api/proxy/")) return true;
  if (p.startsWith("/_next/")) {
    // /_next/image はターゲット（Next.js 製サイト）の最適化エンドポイント（#102）。
    // 自前ルートから除外し、ターゲット origin の /_next/image へ振り向ける。
    if (p === "/_next/image" || p.startsWith("/_next/image/")) return false;
    return true;
  }
  if (p === "/favicon.ico") return true;
  return false;
}

// 実行時リクエスト（fetch / XHR）の URL を /api/proxy/<scheme>/<host>/<path> 形式の
// 振り向け先へ書き換える。SW の rewriteRequestUrl（public/sw.js）と同一規則。
// クロスオリジン絶対 URL はそのまま中継、同一オリジンの非自前パスは閲覧ページから
// ターゲット origin を復元して解決、自前ルート・非 http(s)・復元不能は null（素通し）。
// 注入スクリプトはこの関数と isProxyOwnPath / extractBrowseTarget を toString() で
// 埋め込むため、外部参照を持たず URL のみで完結させる。
// 仕様: docs/spec/features/proxy.md §実行時リクエスト横取りシム（SW 非依存・#124）
export function buildRequestInterceptUrl(
  requestUrl: string,
  pageUrl: string,
  swOrigin: string,
  basePath: string
): string | null {
  let req: URL;
  try {
    req = new URL(requestUrl, pageUrl);
  } catch {
    return null;
  }
  // http(s) 以外（data:/blob:/javascript: 等）は素通し。
  if (req.protocol !== "http:" && req.protocol !== "https:") return null;

  const toProxy = (u: URL): string =>
    basePath +
    "/api/proxy/" +
    u.protocol.replace(/:$/, "") +
    "/" +
    u.host +
    u.pathname +
    u.search +
    u.hash;

  // クロスオリジンの絶対 URL → そのまま中継
  if (req.origin !== swOrigin) return toProxy(req);

  // 同一オリジン: 自前ルートは横取りしない
  if (isProxyOwnPath(req.pathname, basePath)) return null;

  // 同一オリジンの非自前パス（ルート絶対パス等）→ ターゲット origin に解決
  const target = extractBrowseTarget(pageUrl);
  if (!target) return null;
  let targetOrigin: string;
  try {
    targetOrigin = new URL(target).origin;
  } catch {
    return null;
  }
  let path = req.pathname;
  if (basePath && path.startsWith(basePath)) {
    path = path.slice(basePath.length) || "/";
  }
  let resolved: URL;
  try {
    resolved = new URL(path + req.search + req.hash, targetOrigin);
  } catch {
    return null;
  }
  return toProxy(resolved);
}

// fetch の input（string / URL / Request）から URL 文字列を取り出す。取り出せなければ null。
// URL オブジェクトは .url を持たない（.href を使う）ため、Request の .url と区別して扱う。
// 注入スクリプトに toString() で埋め込むため、外部参照を持たず URL のみで完結させる。
// 仕様: docs/spec/features/proxy.md §実行時リクエスト横取りシム（SW 非依存・#124）
export function fetchInputUrl(input: unknown): string | null {
  if (typeof input === "string") return input;
  if (typeof URL !== "undefined" && input instanceof URL) return input.href;
  if (input && typeof (input as { url?: unknown }).url === "string") {
    return (input as { url: string }).url;
  }
  return null;
}

// <a> クリックによるナビゲーションを横取りする注入スクリプト。
// 純粋ロジック（buildClickNavDestination）を toString() で埋め込み、document への
// click イベント委任（capture）で動的描画リンクも含めて捕捉する。capture は SPA（React 等）の
// onClick（バブル）より先に発火し、dest を得たら stopImmediatePropagation で SPA ルーターの
// クリック横取りを阻止して確実に proxy 経由フルナビゲーションにする。自前 UI（アドレスバー）・
// 修飾キー付き・中クリック・target="_blank" は素通しし、ブラウザ標準の挙動を尊重する。
const CLICK_NAV_INTERCEPT_HTML =
  `<script>(function(){` +
  `var browseNavPrefix=${browseNavPrefix.toString()};` +
  `var extractBrowseTarget=${extractBrowseTarget.toString()};` +
  `var buildBrowseDest=${buildBrowseDest.toString()};` +
  `var build=${buildClickNavDestination.toString()};` +
  `document.addEventListener('click',function(e){` +
  `if(e.defaultPrevented||e.button!==0||e.metaKey||e.ctrlKey||e.shiftKey||e.altKey)return;` +
  `var a=e.target&&e.target.closest&&e.target.closest('a[href]');if(!a)return;` +
  `if(a.closest('#proxy-addressbar'))return;` +
  `var t=a.getAttribute('target');if(t&&t.toLowerCase()==='_blank')return;` +
  `var dest=build(a.getAttribute('href')||'',location.href);` +
  `if(dest){e.preventDefault();e.stopImmediatePropagation();location.href=dest;}` +
  `},true);` +
  `})()</script>`;

// 実行時リクエスト横取りシム（SW 非依存・#124）。window.fetch / XMLHttpRequest.prototype.open を
// 上書きし、リクエスト URL を SW と同一規則で /api/proxy へ振り向ける。SW は初回ロードで
// clients.claim() 確立前のサブリソース要求を横取りできないため、そのギャップを埋める。
// ページ内スクリプトより先に実行させるため <head> 最先頭へ注入する。
// 純粋ロジック（isProxyOwnPath / extractBrowseTarget / buildRequestInterceptUrl）を toString() で
// 埋め込み、ブラウザでは fetch / XHR を上書きする。書き換え先（同一オリジンの /api/proxy）は SW が
// 自前ルートと判定して素通しするため二重書き換えにならない。
// 仕様: docs/spec/features/proxy.md §実行時リクエスト横取りシム（SW 非依存・#124）
const REQUEST_INTERCEPT_HTML =
  `<script>(function(){` +
  `var bp=${JSON.stringify(BASE_PATH)};` +
  `var origin=location.origin;` +
  `var isProxyOwnPath=${isProxyOwnPath.toString()};` +
  `var extractBrowseTarget=${extractBrowseTarget.toString()};` +
  `var fetchInputUrl=${fetchInputUrl.toString()};` +
  `var build=${buildRequestInterceptUrl.toString()};` +
  // fetch 上書き（input は string / URL / Request を許容）。
  `var _fetch=window.fetch;` +
  `if(_fetch){window.fetch=function(input,init){try{` +
  `var url=fetchInputUrl(input);` +
  `if(url!=null){var dest=build(url,location.href,origin,bp);if(dest){` +
  `if(typeof input==='string'||(typeof URL!=='undefined'&&input instanceof URL)){return _fetch(dest,init);}` +
  `return _fetch(new Request(dest,input),init);` +
  `}}}catch(e){}return _fetch(input,init);};}` +
  // XMLHttpRequest.open 上書き（第 2 引数 url を書き換える）。
  `var _open=XMLHttpRequest.prototype.open;` +
  `XMLHttpRequest.prototype.open=function(method,url){try{` +
  `var dest=build(url,location.href,origin,bp);if(dest){arguments[1]=dest;}` +
  `}catch(e){}return _open.apply(this,arguments);};` +
  `})()</script>`;

// 実行時リクエスト横取り Service Worker（public/sw.js）の登録スニペット。
// 登録スコープは ${BASE_PATH}/。SW 側は scope から BASE_PATH を導出する。
const SW_REGISTER_HTML =
  `<script>` +
  `if('serviceWorker' in navigator){` +
  `navigator.serviceWorker.register('${BASE_PATH}/sw.js',{scope:'${BASE_PATH}/'}).catch(function(){});` +
  `}` +
  `</script>`;

// document.domain ベースのドメインガードを無効化するシム。
// 一部サイト（例 Yahoo の yjsecure.js）は document.domain を正規表現で検査し、自オリジン外と
// 判定するとトップフレームを実サイトへリダイレクトする。プロキシ配下では document.domain が
// プロキシのホスト名になりガードが誤発火するため、Document.prototype.domain の getter を
// ターゲットのホスト名返却に上書きして無効化する（document.domain への代入は一部オリジンで
// 禁止され得るため getter 上書き方式を採る）。例外は握り潰す。
// ページ内スクリプトより先に実行させるため <head> 最先頭へ注入する。
// 仕様: docs/spec/features/proxy.md §document.domain ドメインガードの無効化
const DOMAIN_SHIM_HTML = (hostname: string) =>
  `<script>(function(){try{Object.defineProperty(Document.prototype,'domain',` +
  `{configurable:true,get:function(){return ${JSON.stringify(hostname)};},set:function(){}});` +
  `}catch(_){}})()</script>`;

function targetHostname(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname;
  } catch {
    return "";
  }
}

// スニペットを <head> 最先頭へ注入する。<head> が無ければ <html> 直後、
// それも無ければ文書先頭へフォールバックする。
function injectAtHeadStart(html: string, snippet: string): string {
  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/(<head[^>]*>)/i, `$1${snippet}`);
  }
  if (/<html[^>]*>/i.test(html)) {
    return html.replace(/(<html[^>]*>)/i, `$1${snippet}`);
  }
  return snippet + html;
}

export function rewriteHtml(html: string, baseUrl: string): string {
  const root = parse(html);

  // <base href> は相対 URL 解決の基点を変えるため最初に処理する（#135）。
  // 文書内の最初の <base href>（HTML 仕様上、有効なのは最初の 1 つ）を baseUrl で
  // 解決し、http(s) に解決できればそれを以降の全書き換えの実効解決基点とする。
  // そのうえで全 <base> から href を除去する。残すと取りこぼし属性・実行時生成の
  // 相対 URL がブラウザによって <base href> 基準で解決され、プロキシ枠を外れた
  // 実サイト直アクセスを誘発し得る（注入シムは location.href 基準で <base> を見ない）。
  // 仕様: docs/spec/features/proxy.md §<base href> の処理（枠外離脱防止・#135）
  let effectiveBase = baseUrl;
  const firstBaseHref = root.querySelector("base[href]")?.getAttribute("href");
  if (firstBaseHref) {
    const resolved = resolve(firstBaseHref, baseUrl);
    if (resolved.startsWith("http://") || resolved.startsWith("https://")) {
      effectiveBase = resolved;
    }
  }
  root.querySelectorAll("base[href]").forEach((el) => {
    el.removeAttribute("href");
  });

  root.querySelectorAll("a[href]").forEach((el) => {
    const href = el.getAttribute("href");
    if (href && !href.startsWith("#") && !href.startsWith("javascript:")) {
      el.setAttribute("href", browseUrl(href, effectiveBase));
    }
  });

  root.querySelectorAll("form[action]").forEach((el) => {
    const action = el.getAttribute("action");
    if (action) el.setAttribute("action", browseUrl(action, effectiveBase));
  });

  // <iframe src>: 埋め込みページもブラウズ画面で開く（<a href> と同じ browseUrl）。
  // 書き換えないと <base href> 除去後もブラウザが文書 URL 基準で実サイトへ解決し、
  // プロキシ枠を外れた埋め込みになる（#135）。
  root.querySelectorAll("iframe[src]").forEach((el) => {
    const src = el.getAttribute("src");
    if (src && !src.startsWith("#") && !src.startsWith("javascript:")) {
      el.setAttribute("src", browseUrl(src, effectiveBase));
    }
  });

  // <meta http-equiv="refresh" content="<遅延>;url=<TARGET>"> の url を /browse へ。
  // 書き換えないと url=/... のルート相対 refresh がプロキシ自身のオリジン直下へ
  // 解決され、閲覧ページから離脱する（例 Google の enablejs リトライ）。
  // 仕様: docs/spec/features/proxy.md §meta refresh の書き換え
  root.querySelectorAll("meta[http-equiv]").forEach((el) => {
    const httpEquiv = (el.getAttribute("http-equiv") ?? "")
      .trim()
      .toLowerCase();
    // inline CSP（enforce）を除去する。残すと注入スクリプト（nonce 無し）や
    // /api/proxy へ書き換えた src が CSP でブロックされ得る。Report-Only は
    // 実際のブロックを行わずレポートのみのため残す。
    // 仕様: docs/spec/features/proxy.md §inline CSP（meta）の除去
    if (httpEquiv === "content-security-policy") {
      el.remove();
      return;
    }
    if (httpEquiv !== "refresh") return;
    const content = el.getAttribute("content");
    if (!content) return;
    const rewrittenContent = rewriteMetaRefreshContent(content, effectiveBase);
    if (rewrittenContent !== content)
      el.setAttribute("content", rewrittenContent);
  });

  // 静的アセットの src を /api/proxy へ。<source src> は <picture> だけでなく
  // <video>/<audio> 配下も同じセレクタでヒットし、直属の <video src>/<audio src> も
  // メディアの透過中継として書き換える（#135）。
  for (const sel of [
    "img[src]",
    "source[src]",
    "video[src]",
    "audio[src]",
  ] as const) {
    root.querySelectorAll(sel).forEach((el) => {
      const src = el.getAttribute("src");
      if (src) el.setAttribute("src", assetUrl(src, effectiveBase));
    });
  }

  // <img> / <source> の srcset を書き換える。src だけ書き換えて srcset を放置すると
  // ブラウザが srcset 側の未書き換え候補を採用してしまう（#98）。
  for (const sel of ["img[srcset]", "source[srcset]"] as const) {
    root.querySelectorAll(sel).forEach((el) => {
      const srcset = el.getAttribute("srcset");
      if (srcset)
        el.setAttribute("srcset", rewriteSrcset(srcset, effectiveBase));
    });
  }

  // <script src>: src を書き換えたうえで integrity / crossorigin を除去する。
  // 書換後は /api/proxy 経由の中継レスポンスとなり SRI ハッシュが元 URL と
  // 一致せずブロックされる。crossorigin も同一 origin 化で不整合・不要になる。
  // 仕様: docs/spec/features/proxy.md §サブリソース整合性（SRI）属性の除去
  root.querySelectorAll("script[src]").forEach((el) => {
    const src = el.getAttribute("src");
    if (src) el.setAttribute("src", assetUrl(src, effectiveBase));
    el.removeAttribute("integrity");
    el.removeAttribute("crossorigin");
  });

  const RESOURCE_LINK_RELS = new Set([
    "stylesheet",
    "preload",
    "modulepreload",
    "prefetch",
  ]);
  root.querySelectorAll("link[href]").forEach((el) => {
    const rel = el.getAttribute("rel") ?? "";
    const isResource = rel
      .toLowerCase()
      .split(/\s+/)
      .some((r) => RESOURCE_LINK_RELS.has(r));
    if (!isResource) return;
    const href = el.getAttribute("href");
    if (href) el.setAttribute("href", assetUrl(href, effectiveBase));
  });

  const rewritten = root.toString();
  const bar = ADDRESS_BAR_HTML(baseUrl);
  const withBody = rewritten.replace(
    /(<body[^>]*>)/i,
    `$1${bar}${GET_FORM_INTERCEPT_HTML}${CLICK_NAV_INTERCEPT_HTML}${SW_REGISTER_HTML}`
  );

  // <head> 最先頭へのシム注入（ページ内スクリプトより先に実行させる）。
  // 実行時リクエスト横取りシム（#124）は常に注入し、document.domain シム（#69）は
  // ターゲットのホスト名が判明する場合のみ注入する。
  const hostname = targetHostname(baseUrl);
  const headInjection =
    REQUEST_INTERCEPT_HTML + (hostname ? DOMAIN_SHIM_HTML(hostname) : "");
  return injectAtHeadStart(withBody, headInjection);
}

export function rewriteCss(css: string, baseUrl: string): string {
  return css
    .replace(/url\((['"]?)([^'")\s]+)\1\)/g, (_, q, href) => {
      void q;
      return `url("${assetUrl(href, baseUrl)}")`;
    })
    .replace(/@import\s+(['"])([^'"]+)\1/g, (_, q, href) => {
      void q;
      return `@import "${assetUrl(href, baseUrl)}"`;
    });
}
