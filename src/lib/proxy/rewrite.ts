import { parse } from "node-html-parser";

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
  return `${BASE_PATH}/api/proxy?url=${encodeURIComponent(resolved)}`;
}

const ADDRESS_BAR_HTML = (currentUrl: string) =>
  `
<div id="proxy-addressbar" style="position:sticky;top:0;z-index:99999;background:#1e1e2e;padding:6px 12px;display:flex;gap:8px;align-items:center;font-family:sans-serif;box-shadow:0 2px 4px rgba(0,0,0,.4)">
  <form onsubmit="(function(e){e.preventDefault();var v=e.target.querySelector('input').value;if(!v)return;window.location.href='${BASE_PATH}/browse?url='+encodeURIComponent(v.startsWith('http')?v:'https://'+v)})(event)" style="display:flex;flex:1;gap:8px">
    <input value="${currentUrl.replace(/"/g, "&quot;")}" style="flex:1;padding:4px 10px;border:1px solid #555;border-radius:4px;background:#2a2a3e;color:#fff;font-size:14px" />
    <button type="submit" style="padding:4px 14px;background:#0070f3;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:14px">移動</button>
  </form>
  <a href="${BASE_PATH}/" style="color:#aaa;font-size:13px;text-decoration:none">ホーム</a>
</div>`.trim();

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
// document への submit イベント委任（capture）で動的フォームも含めて捕捉する。
// 自前のアドレスバー（#proxy-addressbar 内のフォーム）は独自の onsubmit を持つため
// 横取り対象から除外する（横取りすると入力 URL が無視され得る）。
const GET_FORM_INTERCEPT_HTML =
  `<script>(function(){` +
  `var build=${buildGetFormDestination.toString()};` +
  `document.addEventListener('submit',function(e){` +
  `var f=e.target;if(!f||f.tagName!=='FORM')return;` +
  `if(f.closest&&f.closest('#proxy-addressbar'))return;` +
  `var fd;try{fd=new FormData(f,e.submitter)}catch(_){fd=new FormData(f)}` +
  `var dest=build(f.getAttribute('method')||'get',f.getAttribute('action')||'',location.href,Array.from(fd.entries()));` +
  `if(dest){e.preventDefault();location.href=dest;}` +
  `},true);` +
  `})()</script>`;

// クリックによるナビゲーションの振り向け先を決定する純粋関数。
// JS が動的描画した <a href>（生の http(s) 絶対 URL）はサーバー側 rewriteHtml の
// 書き換え対象外で、クリックすると実サイトへ離脱する。これを補い、http(s) 絶対 URL を
// 閲覧ページのパス（BASE_PATH 込みの …/browse）を再利用して /browse?url=<再エンコード> へ振り向ける。
// 横取り対象外（http(s) 絶対 URL でない＝自前リンク・# ・javascript: ・相対）なら null を返す。
// 注入スクリプトはこの関数を toString() で埋め込むため、外部参照を持たず URL のみで完結させる。
// 仕様: docs/spec/features/proxy.md §クライアント側ナビゲーションの横取り
export function buildClickNavDestination(
  href: string,
  pageUrl: string
): string | null {
  if (!/^https?:\/\//i.test(href)) return null;
  let page: URL;
  try {
    page = new URL(pageUrl);
  } catch {
    return null;
  }
  return page.pathname + "?url=" + encodeURIComponent(href);
}

// <a> クリックによるナビゲーションを横取りする注入スクリプト。
// 純粋ロジック（buildClickNavDestination）を toString() で埋め込み、document への
// click イベント委任（capture）で動的描画リンクも含めて捕捉する。修飾キー付き・
// 中クリック・target="_blank" は素通しし、ブラウザ標準の新規タブ挙動を尊重する。
const CLICK_NAV_INTERCEPT_HTML =
  `<script>(function(){` +
  `var build=${buildClickNavDestination.toString()};` +
  `document.addEventListener('click',function(e){` +
  `if(e.defaultPrevented||e.button!==0||e.metaKey||e.ctrlKey||e.shiftKey||e.altKey)return;` +
  `var a=e.target&&e.target.closest&&e.target.closest('a[href]');if(!a)return;` +
  `var t=a.getAttribute('target');if(t&&t.toLowerCase()==='_blank')return;` +
  `var dest=build(a.getAttribute('href')||'',location.href);` +
  `if(dest){e.preventDefault();location.href=dest;}` +
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
