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
const GET_FORM_INTERCEPT_HTML =
  `<script>(function(){` +
  `var build=${buildGetFormDestination.toString()};` +
  `document.addEventListener('submit',function(e){` +
  `var f=e.target;if(!f||f.tagName!=='FORM')return;` +
  `var fd;try{fd=new FormData(f,e.submitter)}catch(_){fd=new FormData(f)}` +
  `var dest=build(f.getAttribute('method')||'get',f.getAttribute('action')||'',location.href,Array.from(fd.entries()));` +
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

  for (const sel of ["img[src]", "source[src]", "script[src]"] as const) {
    root.querySelectorAll(sel).forEach((el) => {
      const src = el.getAttribute("src");
      if (src) el.setAttribute("src", assetUrl(src, baseUrl));
    });
  }

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
  return rewritten.replace(
    /(<body[^>]*>)/i,
    `$1${bar}${GET_FORM_INTERCEPT_HTML}${SW_REGISTER_HTML}`
  );
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
