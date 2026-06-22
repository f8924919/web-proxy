import { parse } from "node-html-parser";
import { buildProxyPath } from "./proxyPath";

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
  return `${BASE_PATH}/browse?url=${encodeURIComponent(resolved)}`;
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
const ADDRESS_BAR_HTML = (currentUrl: string) =>
  `
<div id="proxy-addressbar" style="position:fixed;top:0;left:0;right:0;z-index:99999;background:#1e1e2e;padding:6px 12px;display:flex;gap:8px;align-items:center;font-family:sans-serif;box-shadow:0 2px 4px rgba(0,0,0,.4)">
  <form onsubmit="(function(e){e.preventDefault();var v=e.target.querySelector('input').value;if(!v)return;window.location.href='${BASE_PATH}/browse?url='+encodeURIComponent(v.startsWith('http')?v:'https://'+v)})(event)" style="display:flex;flex:1;gap:8px">
    <input value="${currentUrl.replace(/"/g, "&quot;")}" style="flex:1;padding:4px 10px;border:1px solid #555;border-radius:4px;background:#2a2a3e;color:#fff;font-size:14px" />
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

// GET フォーム送信の振り向け先を決定する純粋関数。
// GET フォーム送信ではブラウザが action のクエリ文字列（?url=<target>）を破棄し
// フォーム項目で置き換えるため url が消失する。これを補い、ターゲットのクエリを
// フォーム項目で置き換えた /browse?url=<再エンコード> を組み立てる。
// 横取り不要（GET 以外・ターゲット復元不可）なら null を返す。
// 注入スクリプトはこの関数を toString() で埋め込むため、外部参照を持たず
// URL / URLSearchParams（ブラウザ・Node 共通のグローバル）のみで完結させる。
// 仕様: docs/spec/features/proxy.md §GET フォーム送信の横取り
export function buildGetFormDestination(
  method: string,
  action: string,
  pageUrl: string,
  entries: [string, string][]
): string | null {
  if ((method || "get").toLowerCase() !== "get") return null;

  // action（書き換え済み …/browse?url=<target>）を閲覧ページ URL で解決して読む。
  let browseUrl: URL;
  try {
    browseUrl = new URL(action || pageUrl, pageUrl);
  } catch {
    return null;
  }

  let targetStr = browseUrl.searchParams.get("url");
  if (!targetStr) {
    // action 属性なし等で url が無い場合は閲覧ページ自身の url をフォールバックに使う。
    try {
      const page = new URL(pageUrl);
      targetStr = page.searchParams.get("url");
      browseUrl = page;
    } catch {
      return null;
    }
  }
  if (!targetStr) return null;

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

  // パス部（BASE_PATH 込みの …/browse）を再利用して url を載せ替える。
  return browseUrl.pathname + "?url=" + encodeURIComponent(target.href);
}

// GET フォーム送信を横取りする注入スクリプト。
// 純粋ロジック（buildGetFormDestination）を toString() で埋め込み、ブラウザでは
// 2 経路で捕捉する:
//  (A) document への submit イベント委任（capture）。動的フォーム・ネイティブ submit・
//      requestSubmit（submit イベントを発火する）を含めて捕捉する。横取り時は
//      preventDefault に加え stopImmediatePropagation を呼び、SPA（React 等）が
//      バブルの自前 submit ハンドラで実サイトへ後勝ち遷移するのを阻止する（#93。
//      クリック横取りと同方式。例: www.yahoo.co.jp トップ検索）。
//  (B) HTMLFormElement.prototype.submit のオーバーライド。form.submit()（プログラム送信）は
//      submit イベントを発火しないため (A) で捕捉できない（例: Google 検索）。同じ
//      buildGetFormDestination を適用して振り向ける（#78）。
// 自前のアドレスバー（#proxy-addressbar 内のフォーム）は独自の onsubmit を持つため
// 双方で横取り対象から除外する（横取りすると入力 URL が無視され得る）。
const GET_FORM_INTERCEPT_HTML =
  `<script>(function(){` +
  `var build=${buildGetFormDestination.toString()};` +
  `document.addEventListener('submit',function(e){` +
  `var f=e.target;if(!f||f.tagName!=='FORM')return;` +
  `if(f.closest&&f.closest('#proxy-addressbar'))return;` +
  `var fd;try{fd=new FormData(f,e.submitter)}catch(_){fd=new FormData(f)}` +
  `var dest=build(f.getAttribute('method')||'get',f.getAttribute('action')||'',location.href,Array.from(fd.entries()));` +
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
// 実サイトへ離脱する。これを補い、クリック先を proxy 中継（…/browse?url=）へ振り向ける。
// 返り値は遷移先パス（BASE_PATH 込みの …/browse を再利用）、横取りしない場合は null。
//   - 外部オリジンの絶対 URL（プロトコル相対含む）→ …/browse?url=<encode(絶対URL)>
//   - 同一オリジンの …/browse リンク（書き換え済み）→ その path+search をそのまま返す
//     （SPA ルーターに奪われる前にフルナビゲーションさせる）
//   - 同一オリジンのその他パス（/articles/… 等）→ 現在ページの url= を base に解決し直して振り向け
//   - # 同一ページアンカー・非 http スキーム・url= 欠落時の相対は null
// 注入スクリプトはこの関数を toString() で埋め込むため、外部参照を持たず URL のみで完結させる。
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
    // 既に書き換え済みの browse リンク（同一 …/browse パスかつ url= を持つ）はそのまま
    // フルナビゲーション。url= の有無を要するのは、ターゲット側 SPA が描画するクエリのみの
    // 相対リンク（例 DuckDuckGo「Searches related to」の ?q=…）がブラウザ既定で同一 …/browse
    // パスへ解決され、url= を持たないまま素通しされてプロキシが外れるのを防ぐため（#114）。
    if (dest.pathname === page.pathname && dest.searchParams.has("url")) {
      return dest.pathname + dest.search + dest.hash;
    }
    // それ以外の同一オリジン（例 /articles/… のルート相対・相対、および上記のクエリのみ相対
    // ?q=…）は、ブラウザ既定だと proxy オリジン直下や url= 無しの …/browse へ解決され離脱・
    // 失効する。現ターゲット（url=）を base に解決し直して proxy 中継へ振り向ける。
    const target = page.searchParams.get("url");
    if (!target) return null;
    let real: URL;
    try {
      real = new URL(href, target);
    } catch {
      return null;
    }
    if (real.protocol !== "http:" && real.protocol !== "https:") return null;
    return page.pathname + "?url=" + encodeURIComponent(real.href);
  }
  // 外部オリジンの絶対 URL（プロトコル相対含む）。
  return page.pathname + "?url=" + encodeURIComponent(dest.href);
}

// <a> クリックによるナビゲーションを横取りする注入スクリプト。
// 純粋ロジック（buildClickNavDestination）を toString() で埋め込み、document への
// click イベント委任（capture）で動的描画リンクも含めて捕捉する。capture は SPA（React 等）の
// onClick（バブル）より先に発火し、dest を得たら stopImmediatePropagation で SPA ルーターの
// クリック横取りを阻止して確実に proxy 経由フルナビゲーションにする。自前 UI（アドレスバー）・
// 修飾キー付き・中クリック・target="_blank" は素通しし、ブラウザ標準の挙動を尊重する。
const CLICK_NAV_INTERCEPT_HTML =
  `<script>(function(){` +
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

  root.querySelectorAll("a[href]").forEach((el) => {
    const href = el.getAttribute("href");
    if (href && !href.startsWith("#") && !href.startsWith("javascript:")) {
      el.setAttribute("href", browseUrl(href, baseUrl));
    }
  });

  root.querySelectorAll("form[action]").forEach((el) => {
    const action = el.getAttribute("action");
    if (action) el.setAttribute("action", browseUrl(action, baseUrl));
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
    const rewrittenContent = rewriteMetaRefreshContent(content, baseUrl);
    if (rewrittenContent !== content)
      el.setAttribute("content", rewrittenContent);
  });

  for (const sel of ["img[src]", "source[src]"] as const) {
    root.querySelectorAll(sel).forEach((el) => {
      const src = el.getAttribute("src");
      if (src) el.setAttribute("src", assetUrl(src, baseUrl));
    });
  }

  // <img> / <source> の srcset を書き換える。src だけ書き換えて srcset を放置すると
  // ブラウザが srcset 側の未書き換え候補を採用してしまう（#98）。
  for (const sel of ["img[srcset]", "source[srcset]"] as const) {
    root.querySelectorAll(sel).forEach((el) => {
      const srcset = el.getAttribute("srcset");
      if (srcset) el.setAttribute("srcset", rewriteSrcset(srcset, baseUrl));
    });
  }

  // <script src>: src を書き換えたうえで integrity / crossorigin を除去する。
  // 書換後は /api/proxy 経由の中継レスポンスとなり SRI ハッシュが元 URL と
  // 一致せずブロックされる。crossorigin も同一 origin 化で不整合・不要になる。
  // 仕様: docs/spec/features/proxy.md §サブリソース整合性（SRI）属性の除去
  root.querySelectorAll("script[src]").forEach((el) => {
    const src = el.getAttribute("src");
    if (src) el.setAttribute("src", assetUrl(src, baseUrl));
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
    if (href) el.setAttribute("href", assetUrl(href, baseUrl));
  });

  const rewritten = root.toString();
  const bar = ADDRESS_BAR_HTML(baseUrl);
  const withBody = rewritten.replace(
    /(<body[^>]*>)/i,
    `$1${bar}${GET_FORM_INTERCEPT_HTML}${CLICK_NAV_INTERCEPT_HTML}${SW_REGISTER_HTML}`
  );

  const hostname = targetHostname(baseUrl);
  if (!hostname) return withBody;
  return injectAtHeadStart(withBody, DOMAIN_SHIM_HTML(hostname));
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
